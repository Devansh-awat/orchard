import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposeStacksService } from '../src/compose-stacks/compose-stacks.service';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import {
  composeAliasName,
  parseComposePorts,
  planComposeAliases,
  urlPortOf
} from '../src/compose-stacks/compose-network';

const WORDPRESS = `
services:
  db:
    image: mariadb:10.6.4-focal
    command: '--default-authentication-plugin=mysql_native_password'
    volumes:
      - db_data:/var/lib/mysql
    environment:
      - MYSQL_ROOT_PASSWORD=somewordpress
    expose:
      - 3306
      - 33060
  wordpress:
    image: wordpress:latest
    volumes:
      - wp_data:/var/www/html
    ports:
      - 80:80
    environment:
      - WORDPRESS_DB_HOST=db
volumes:
  db_data:
  wp_data:
`;

function composeHarness(conflicts: string[] = []) {
  const created: any[] = [];
  const urls: any[] = [];
  const aliasCalls: any[] = [];
  const children: any[] = [];
  const stack = { id: 'stack', projectId: 'p', environmentId: 'e', name: 'wp' };
  const service = Object.create(ComposeStacksService.prototype) as any;
  service.logger = { warn: () => undefined };
  service.prisma = {
    composeStack: { findUnique: async () => stack },
    deployment: { findMany: async () => children }
  };
  service.deployments = {
    createDeployment: async (_p: string, data: any) => {
      created.push(data);
      children.push({
        name: data.name,
        namespace: 'ns',
        composeServiceName: data.composeServiceName,
        services: [
          {
            ports: (data.ports ?? [{ containerPort: 80 }]).map((port: any) => ({
              targetPort: port.containerPort,
              protocol: port.protocol ?? 'TCP'
            }))
          }
        ]
      });
      return { id: data.name };
    }
  };
  service.ingress = {
    createAutoIngressForDeployment: async (id: string, _c: string, _u: unknown, choice: any) => {
      urls.push([id, choice.servicePort]);
      return null;
    }
  };
  service.credentials = {
    detectImagePorts: async () => ({ port: 6379, ports: [{ port: 6379, protocol: 'tcp' }] })
  };
  service.k8sWorkload = {
    syncComposeAliases: async (...args: unknown[]) => {
      aliasCalls.push(args);
      return { conflicts };
    }
  };
  return { service, created, urls, aliasCalls };
}

test('the wordpress example: siblings reach each other by compose name', async () => {
  const { service, created, urls, aliasCalls } = composeHarness();
  const services = service.parseCompose(WORDPRESS, 'compose.yaml');
  await service.deployChildren('stack', services, 'clerk');
  await service.syncServiceAliases('stack', 'refuse');

  const db = created.find((c) => c.name === 'wp-db');
  assert.deepEqual(
    db.ports.map((p: any) => p.containerPort),
    [3306, 33060]
  );
  const wordpress = created.find((c) => c.name === 'wp-wordpress');
  assert.deepEqual(wordpress.ports, [{ containerPort: 80, servicePort: 80, protocol: 'TCP' }]);
  assert.deepEqual(urls, [['wp-wordpress', 80]]);

  const [namespace, stackId, aliases] = aliasCalls[0];
  assert.equal(namespace, 'ns');
  assert.equal(stackId, 'stack');
  assert.deepEqual(
    aliases.find((a: any) => a.name === 'db'),
    {
      name: 'db',
      target: 'wp-db',
      ports: [
        { port: 3306, protocol: 'TCP' },
        { port: 33060, protocol: 'TCP' }
      ]
    }
  );
});

test('an image with no ports in the file uses what the image exposes, with no URL', async () => {
  const { service, created, urls } = composeHarness();
  const services = service.parseCompose(
    'services:\n  cache:\n    image: redis:7\n',
    'compose.yaml'
  );
  await service.deployChildren('stack', services, 'clerk');
  assert.deepEqual(created[0].ports, [{ containerPort: 6379, servicePort: 6379, protocol: 'TCP' }]);
  assert.deepEqual(urls, []);
});

test('a name another stack holds refuses a new stack and only warns on redeploy', async () => {
  const { service } = composeHarness(['db']);
  const services = service.parseCompose(WORDPRESS, 'compose.yaml');
  await service.deployChildren('stack', services, 'clerk');
  await assert.rejects(
    service.syncServiceAliases('stack', 'refuse'),
    /already used in this project/
  );
  await service.syncServiceAliases('stack', 'warn');
});

test('compose port syntax', () => {
  assert.deepEqual(parseComposePorts({ ports: ['127.0.0.1:8080:80/udp'] }).ports, [
    { containerPort: 80, servicePort: 8080, protocol: 'UDP' }
  ]);
  assert.deepEqual(parseComposePorts({ ports: [{ target: 80, published: '8080' }] }).ports, [
    { containerPort: 80, servicePort: 8080, protocol: 'TCP' }
  ]);
  assert.deepEqual(parseComposePorts({ ports: [3000] }).published, [
    { containerPort: 3000, servicePort: 3000, protocol: 'TCP' }
  ]);
  const both = parseComposePorts({ ports: ['8080:80'], expose: ['80', '9000/tcp'] });
  assert.deepEqual(
    both.ports.map((p) => p.containerPort),
    [80, 9000]
  );
  assert.equal(both.published.length, 1);
  assert.deepEqual(parseComposePorts({}).ports, []);
});

test('a database published with ports does not get a URL', () => {
  const pg = parseComposePorts({ ports: ['5432:5432'] });
  assert.equal(urlPortOf(pg.published), null);
  const mixed = parseComposePorts({ ports: ['5432:5432', '8080:80'] });
  assert.equal(urlPortOf(mixed.published), 8080);
});

test('aliases map container ports and skip names DNS cannot carry', () => {
  assert.equal(composeAliasName('my_db'), null);
  assert.equal(composeAliasName('DB'), 'db');
  assert.deepEqual(
    planComposeAliases([
      {
        name: 'wp-web',
        composeServiceName: 'web',
        services: [{ ports: [{ targetPort: 80, protocol: 'TCP' }] }]
      },
      { name: 'wp-my_db', composeServiceName: 'my_db', services: [{ ports: [] }] }
    ]),
    [{ name: 'web', target: 'wp-web', ports: [{ port: 80, protocol: 'TCP' }] }]
  );
});

function k8sHarness(live: Record<string, any>) {
  const calls: string[] = [];
  const core = {
    readNamespacedService: async (name: string) => {
      if (live[name]) return { body: live[name] };
      throw Object.assign(new Error('nope'), { response: { statusCode: 404 } });
    },
    createNamespacedService: async (_ns: string, body: any) => {
      calls.push(`create ${body.metadata.name} -> ${body.spec.selector['app.kubernetes.io/name']}`);
    },
    patchNamespacedService: async (name: string) => {
      calls.push(`patch ${name}`);
    },
    listNamespacedService: async () => ({
      body: {
        items: Object.entries(live)
          .filter(([, v]) => v.metadata?.labels?.['orchard.my/compose-alias-stack'] === 's1')
          .map(([name]) => ({ metadata: { name } }))
      }
    }),
    deleteNamespacedService: async (name: string) => {
      calls.push(`delete ${name}`);
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.ensureKubeConfig = () => undefined;
  service.kubernetes = { kc: { makeApiClient: () => core } };
  return { service, calls };
}

const alias = { name: 'db', target: 'wp-db', ports: [{ port: 3306, protocol: 'TCP' }] };

test('alias sync creates, updates its own and removes what left the file', async () => {
  const own = { metadata: { labels: { 'orchard.my/compose-alias-stack': 's1' } } };
  const { service, calls } = k8sHarness({ db: own, old: own });
  assert.deepEqual(await service.syncComposeAliases('ns', 's1', [alias]), { conflicts: [] });
  assert.deepEqual(calls, ['patch db', 'delete old']);

  const fresh = k8sHarness({});
  await fresh.service.syncComposeAliases('ns', 's1', [alias]);
  assert.deepEqual(fresh.calls, ['create db -> wp-db']);
});

test('alias sync never touches a service it does not own', async () => {
  for (const labels of [
    { 'orchard.my/compose-alias-stack': 's2' },
    { 'app.kubernetes.io/managed-by': 'orchard' }
  ]) {
    const { service, calls } = k8sHarness({ db: { metadata: { labels } } });
    assert.deepEqual(await service.syncComposeAliases('ns', 's1', [alias]), { conflicts: ['db'] });
    assert.deepEqual(calls, []);
  }
});
