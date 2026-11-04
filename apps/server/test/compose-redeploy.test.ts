import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposeStacksService } from '../src/compose-stacks/compose-stacks.service';

function child(overrides: Record<string, unknown>) {
  return {
    githubRepo: null,
    image: null,
    replicas: 1,
    stopped: false,
    cpuRequestMilli: null,
    memoryRequestBytes: null,
    startCommand: null,
    dockerfilePath: null,
    buildFromRoot: false,
    envVars: [],
    volumes: [],
    services: [],
    ...overrides
  };
}

function harness(composeYaml: string, children: any[], volumeTaken?: string) {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return {};
    };
  const stack = {
    id: 'stack',
    projectId: 'project',
    environmentId: 'env',
    name: 'app',
    githubRepo: 'https://github.com/acme/app',
    githubBranch: 'main',
    composePath: 'docker-compose.yml',
    autoDeployEnabled: false,
    autoDeployBranch: null
  };
  const service = Object.create(ComposeStacksService.prototype) as any;
  service.prisma = {
    composeStack: {
      findUnique: async () => stack,
      update: async () => stack
    },
    deployment: {
      findMany: async ({ where }: any) =>
        where.id?.in ? children.filter((c) => where.id.in.includes(c.id)) : children
    }
  };
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'user' }) };
  service.authz = { requireProjectEdit: async () => ({}) };
  service.fetchComposeFromGithub = async () => ({ composeYaml, installationId: 1 });
  service.getComposeStack = async () => stack;
  service.deployments = {
    assertEnvironmentVolumesUnclaimed: async (...args: unknown[]) => {
      calls.push(['preflight', ...args]);
      if (volumeTaken) throw new Error(volumeTaken);
    },
    deleteDeployment: record('delete'),
    createDeployment: record('create'),
    createDeploymentFromGitHub: record('createFromGitHub'),
    updateDeploymentEnvVars: record('env'),
    updateDeploymentVolumes: record('volumes'),
    updateDeploymentResources: record('resources'),
    scaleDeployment: record('scale'),
    updateServiceConfiguration: record('ports'),
    updateDeploymentBuildConfig: record('buildConfig'),
    rebuildDeployment: record('rebuild'),
    updateDeploymentImage: record('image'),
    restartDeployment: record('restart')
  };
  return {
    service,
    calls,
    names: () => calls.filter((c) => c[0] !== 'preflight').map((c) => c[0])
  };
}

const webPorts = [{ port: 3000, targetPort: 3000, protocol: 'TCP' }];

test('redeploy keeps existing services in place so their domains survive', async () => {
  const yaml = `
services:
  web:
    build: .
    ports: ["3000:3000"]
  cache:
    image: redis:7
`;
  const { service, names } = harness(yaml, [
    child({
      id: 'web',
      name: 'app-web',
      composeServiceName: 'web',
      githubRepo: 'https://github.com/acme/app',
      dockerfilePath: 'Dockerfile',
      buildFromRoot: true,
      services: [{ id: 'svc-web', name: 'app-web', ports: webPorts }]
    }),
    child({ id: 'cache', name: 'app-cache', composeServiceName: 'cache', image: 'redis:7' })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  assert.deepEqual(names(), ['rebuild', 'restart']);
});

test('only services added to or removed from the file are created or deleted', async () => {
  const yaml = `
services:
  web:
    image: nginx:1.27
  worker:
    image: acme/worker:1
`;
  const { service, calls } = harness(yaml, [
    child({ id: 'web', name: 'app-web', composeServiceName: 'web', image: 'nginx:1.27' }),
    child({ id: 'old', name: 'app-old', composeServiceName: 'old', image: 'busybox' })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  assert.deepEqual(
    calls.find((c) => c[0] === 'delete'),
    ['delete', 'old', 'clerk', undefined, { fromComposeStack: true }]
  );
  assert.equal(calls.filter((c) => c[0] === 'delete').length, 1);
  const created = calls.filter((c) => c[0] === 'create');
  assert.equal(created.length, 1);
  assert.equal((created[0][2] as any).composeServiceName, 'worker');
});

test('redeploy moves a service to the build context its compose file names', async () => {
  const yaml = `
services:
  backend:
    build: backend
`;
  const { service, calls } = harness(yaml, [
    child({
      id: 'backend',
      name: 'app-backend',
      composeServiceName: 'backend',
      githubRepo: 'https://github.com/acme/app',
      dockerfilePath: 'Dockerfile',
      buildFromRoot: false
    })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  assert.deepEqual(calls.find((c) => c[0] === 'buildConfig')![2], {
    dockerfilePath: 'backend/Dockerfile'
  });
});

test('a volume with an underscore keeps one valid claim across redeploys', async () => {
  const yaml = `
services:
  db:
    image: mysql:8
    volumes: ["db_data:/var/lib/mysql"]
`;
  const first = harness(yaml, []);
  await first.service.redeployFromGithub('stack', 'clerk');
  const created = first.calls.find((c) => c[0] === 'create')![2] as any;
  const claim = created.volumes[0].name;
  assert.match(claim, /^db-data-[0-9a-f]{8}$/);
  assert.equal(created.volumes[0].pvcName, claim);

  const second = harness(yaml, [
    child({
      id: 'db',
      name: 'app-db',
      composeServiceName: 'db',
      image: 'mysql:8',
      volumes: [{ name: claim, type: 'pvc', mountPath: '/var/lib/mysql', pvcName: claim }]
    })
  ]);
  await second.service.redeployFromGithub('stack', 'clerk');
  assert.ok(!second.names().includes('volumes'));
});

test('compose changes are applied to the existing deployment', async () => {
  const yaml = `
services:
  web:
    image: nginx:1.28
    ports: ["8080:8080"]
    environment:
      MODE: prod
    volumes: ["data:/data"]
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "0.5"
          memory: 256Mi
`;
  const { service, calls } = harness(yaml, [
    child({
      id: 'web',
      name: 'app-web',
      composeServiceName: 'web',
      image: 'nginx:1.27',
      envVars: [
        { key: 'MODE', value: 'dev', secret: false },
        { key: 'API_KEY', value: 'ciphertext', secret: true }
      ],
      services: [{ id: 'svc-web', name: 'app-web', ports: webPorts }]
    })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  const byName = new Map(calls.map((c) => [c[0], c]));
  assert.ok(!byName.has('delete'));
  assert.deepEqual(byName.get('env')![2], [
    { key: 'API_KEY', value: null, secret: true },
    { key: 'MODE', value: 'prod', secret: false }
  ]);
  assert.deepEqual(
    (byName.get('volumes')![2] as any[]).map((v) => v.name),
    ['data']
  );
  assert.deepEqual(byName.get('resources')![2], {
    cpuRequestMilli: 500,
    memoryRequestBytes: 256 * 1024 ** 2
  });
  assert.equal(byName.get('scale')![2], 2);
  assert.deepEqual(byName.get('ports')![3], {
    ports: [{ containerPort: 8080, servicePort: 8080, protocol: 'TCP' }]
  });
  assert.deepEqual(byName.get('image')!.slice(1), [
    'web',
    'nginx:1.28',
    'user',
    { fromComposeStack: true }
  ]);
  assert.ok(!byName.has('restart'));
});

test('a service that switches between image and build is replaced', async () => {
  const yaml = `
services:
  web:
    build: .
`;
  const { service, names } = harness(yaml, [
    child({ id: 'web', name: 'app-web', composeServiceName: 'web', image: 'nginx' })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  assert.deepEqual(names(), ['delete', 'createFromGitHub']);
});

const sharing = `
services:
  web:
    image: nginx:1.27
    volumes: ["data:/data"]
  worker:
    image: acme/worker:1
    volumes: ["data:/data"]
`;

test('a file whose services share a volume is refused before anything changes', async () => {
  const { service, names } = harness(sharing, [
    child({ id: 'web', name: 'app-web', composeServiceName: 'web', image: 'nginx:1.27' })
  ]);
  await assert.rejects(
    service.redeployFromGithub('stack', 'clerk'),
    /Services "web" and "worker" both use volume "data"/
  );
  assert.deepEqual(names(), []);
});

test('one service mounting a volume twice is not sharing', () => {
  const service = Object.create(ComposeStacksService.prototype) as any;
  const parsed = service.parseCompose(`
services:
  web:
    image: nginx:1.27
    volumes: ["data:/a", "data:/b"]
`);
  assert.equal(parsed[0].volumes.length, 2);
});

test('a volume held by another app stops a redeploy before any teardown', async () => {
  const yaml = `
services:
  web:
    image: nginx:1.27
    volumes: ["data:/data"]
`;
  const { service, names } = harness(
    yaml,
    [child({ id: 'old', name: 'app-old', composeServiceName: 'old', image: 'busybox' })],
    'Volume "data" is already used by "blog"'
  );
  await assert.rejects(service.redeployFromGithub('stack', 'clerk'), /already used by "blog"/);
  assert.deepEqual(names(), []);
});

test('the preflight ignores volumes the stack already owns', async () => {
  const yaml = `
services:
  web:
    image: nginx:1.27
    volumes: ["data:/data"]
`;
  const { service, calls } = harness(yaml, [
    child({ id: 'web', name: 'app-web', composeServiceName: 'web', image: 'nginx:1.27' })
  ]);
  await service.redeployFromGithub('stack', 'clerk');
  const preflight = calls.find((c) => c[0] === 'preflight')!;
  assert.deepEqual(preflight[4], ['web']);
});
