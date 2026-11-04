import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPodResourcesForImage } from '../src/kubernetes/presets';
import { TemplateEngineService } from '../src/templates/template-engine.service';
import {
  chosenPodSize,
  isolateTemplateVolumes,
  recommendedPodSize
} from '../src/templates/template-defaults';
import { TemplatesService } from '../src/templates/templates.service';

const MiB = 1024 * 1024;
const engine = new TemplateEngineService();

test('a small box can lower the database default, and only with the env var set', () => {
  const big = { cpuMilli: 500, memoryBytes: 1024 * MiB };
  assert.deepEqual(recommendedPodSize('db', 'database', {}), big);
  assert.deepEqual(defaultPodResourcesForImage('postgres'), big);
  try {
    process.env.DATABASE_DEFAULT_MEMORY_MB = '512';
    assert.equal(recommendedPodSize('db', 'database', {}).memoryBytes, 512 * MiB);
    assert.equal(defaultPodResourcesForImage('postgres:17').memoryBytes, 512 * MiB);
    assert.equal(defaultPodResourcesForImage('nginx').memoryBytes, 128 * MiB);
    process.env.DATABASE_DEFAULT_MEMORY_MB = '16';
    assert.equal(defaultPodResourcesForImage('postgres').memoryBytes, 256 * MiB);
    process.env.DATABASE_DEFAULT_MEMORY_MB = 'lots';
    assert.deepEqual(defaultPodResourcesForImage('postgres'), big);
  } finally {
    delete process.env.DATABASE_DEFAULT_MEMORY_MB;
  }
});

test('a declared size is read from the template', () => {
  assert.deepEqual(
    recommendedPodSize('app', 'deployment', { resources: { cpu: '1500m', memory: '2Gi' } }),
    { cpuMilli: 1500, memoryBytes: 2048 * MiB }
  );
  assert.deepEqual(recommendedPodSize('app', 'deployment', { resources: { cpu: 2 } }), {
    cpuMilli: 2000,
    memoryBytes: 512 * MiB
  });
});

test('an undeclared app or database still gets a usable size', () => {
  assert.deepEqual(recommendedPodSize('app', 'deployment', { image: 'ghost:5' }), {
    cpuMilli: 500,
    memoryBytes: 512 * MiB
  });
  assert.equal(recommendedPodSize('db', 'database', {}).memoryBytes, 1024 * MiB);
  assert.equal(
    recommendedPodSize('db', 'deployment', { image: 'mariadb:11' }).memoryBytes,
    1024 * MiB
  );
});

test('a broken size is refused instead of becoming unlimited', () => {
  for (const resources of [
    { memory: 'lots' },
    { memory: '{{ params.memory }}' },
    { memory: '0Gi' },
    { cpu: '1Gi' },
    { cpu: 0 },
    'big'
  ]) {
    assert.throws(() => recommendedPodSize('app', 'deployment', { resources }));
  }
});

test('a tweak to one service beats a size for all of them, which beats the recommendation', () => {
  const recommended = { cpuMilli: 500, memoryBytes: 1024 * MiB };
  assert.deepEqual(chosenPodSize(recommended), {
    cpuRequestMilli: 500,
    memoryRequestBytes: 1024 * MiB
  });
  assert.deepEqual(chosenPodSize(recommended, { cpuRequestMilli: 200 }), {
    cpuRequestMilli: 200,
    memoryRequestBytes: 1024 * MiB
  });
  assert.deepEqual(
    chosenPodSize(
      recommended,
      { cpuRequestMilli: 200, memoryRequestBytes: 300 },
      { memoryRequestBytes: 400 }
    ),
    { cpuRequestMilli: 200, memoryRequestBytes: 400 }
  );
});

test('a zero or negative tweak cannot slip past the quota as unlimited', () => {
  const recommended = { cpuMilli: 500, memoryBytes: 1024 * MiB };
  assert.throws(() => chosenPodSize(recommended, null, { cpuRequestMilli: 0 }));
  assert.throws(() => chosenPodSize(recommended, { memoryRequestBytes: -1 }));
});

test('template volumes get random, valid disk names and temporary ones stay alone', () => {
  const volumes = [
    { name: 'data', type: 'pvc', mountPath: '/data' },
    { name: 'tmp', type: 'emptyDir', mountPath: '/tmp' }
  ];
  const first = isolateTemplateVolumes('Vault Warden', volumes);
  const second = isolateTemplateVolumes('Vault Warden', volumes);
  assert.match(first[0].pvcName, /^vault-warden-data-[0-9a-f]{6}$/);
  assert.notEqual(first[0].pvcName, second[0].pvcName);
  assert.equal('pvcName' in first[1], false);
});

test('a long name still fits a kubernetes name', () => {
  const [vol] = isolateTemplateVolumes('a'.repeat(60), [{ name: 'data', type: 'pvc' }]);
  assert.ok(vol.pvcName.length <= 63);
  assert.match(vol.pvcName, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
});

const yaml = `apiVersion: leaf/v1
kind: Template
metadata:
  name: demo
  version: '1.0.0'
resources:
  - name: db
    type: database
    config:
      name: demo-db
      resources:
        cpu: 750m
        memory: 3Gi
  - name: app
    type: deployment
    config:
      name: demo
      image: demo:1
      resources:
        cpu: 1000m
        memory: 2Gi
      volumes:
        - name: data
          type: pvc
          mountPath: /data
  - name: site
    type: ingress
    config:
      host: demo.example.com
      serviceName: demo
      servicePort: 80
`;

function harness() {
  const calls: Record<string, any[]> = { deployments: [], databases: [] };
  const prisma = {
    template: {
      findUnique: async ({ where }: any) => (where.id ? { id: 'tpl', yaml } : null)
    },
    templateInstance: {
      create: async () => ({ id: 'inst' }),
      update: async () => ({})
    },
    service: { findMany: async () => [{ name: 'demo-svc', ports: [] }] },
    ingress: { findFirst: async () => ({ id: 'ing' }) }
  };
  const service = new TemplatesService(
    prisma as any,
    {} as any,
    {
      createDatabase: async (_p: string, data: any) => {
        calls.databases.push(data);
        return { id: 'db', host: 'h', port: 5432, dbName: 'n', dbUser: 'u' };
      },
      databaseConnection: async () => ({ password: 'p', connectionString: 'c' })
    } as any,
    {
      createDeployment: async (_p: string, data: any) => {
        calls.deployments.push(data);
        return { id: 'dep' };
      }
    } as any,
    { createProjectIngress: async () => ({}) } as any,
    engine,
    { requireProjectEdit: async () => {} } as any,
    { findOrCreateByClerkId: async () => ({ id: 'user' }) } as any,
    { canCoordinate: true } as any
  );
  (service as any).getTemplateInstance = async () => ({ id: 'inst' });
  return { service, calls };
}

test('deploying uses the recommended sizes and gives the app its own disk', async () => {
  const { service, calls } = harness();
  await service.deployTemplate('project', 'tpl', {}, 'clerk');
  assert.equal(calls.databases[0].cpuRequestMilli, 750);
  assert.equal(calls.databases[0].memoryRequestBytes, 3072 * MiB);
  assert.equal(calls.deployments[0].cpuRequestMilli, 1000);
  assert.equal(calls.deployments[0].memoryRequestBytes, 2048 * MiB);
  assert.match(calls.deployments[0].volumes[0].pvcName, /^demo-data-[0-9a-f]{6}$/);
});

test('deploying honours a tweak to one service and leaves the others recommended', async () => {
  const { service, calls } = harness();
  await service.deployTemplate('project', 'tpl', {}, 'clerk', undefined, undefined, {
    app: { memoryRequestBytes: 4096 * MiB, cpuRequestMilli: null }
  });
  assert.equal(calls.deployments[0].memoryRequestBytes, 4096 * MiB);
  assert.equal(calls.deployments[0].cpuRequestMilli, 1000);
  assert.equal(calls.databases[0].memoryRequestBytes, 3072 * MiB);
});

test('every template in the repo declares a size for everything it runs', () => {
  const dirs = [
    join(__dirname, '../../../registry/templates'),
    join(__dirname, '../src/templates/built-in')
  ];
  let checked = 0;
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      const raw = readFileSync(join(dir, file), 'utf8');
      const parsed = engine.parseTemplate(raw);
      for (const resource of parsed.resources) {
        if (resource.type === 'ingress') continue;
        assert.ok(resource.config.resources, `${file}: ${resource.name} has no recommended size`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 99);
});
