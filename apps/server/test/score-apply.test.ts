import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoreService } from '../src/score/score.service';

const SCORE = `
apiVersion: score.dev/v1b1
metadata:
  name: web
  annotations:
    orchard.my/domain: web.example.com
    orchard.my/replicas: "2"
containers:
  web:
    image: .
    variables:
      DATABASE_URL: \${resources.db.connection_string}
      LOG_LEVEL: info
service:
  ports:
    www:
      port: 8080
      targetPort: 3000
resources:
  db:
    type: postgres
`;

interface Calls {
  createdDatabases: string[];
  bound: { resourceId: string; name: string }[];
  env: { key: string; value: string | null; secret: boolean }[] | null;
  ports: unknown;
  scaled: number | null;
  ingress: { host: string; deploymentId: string } | null;
}

function harness(opts: { existingDb?: boolean; existingIngressOwner?: string | null } = {}) {
  const calls: Calls = {
    createdDatabases: [],
    bound: [],
    env: null,
    ports: null,
    scaled: null,
    ingress: null
  };
  const deployment = {
    id: 'dep-1',
    name: 'web',
    projectId: 'proj-1',
    environmentId: 'env-1',
    replicas: 1,
    project: { id: 'proj-1', organizationId: 'org-1' },
    services: [{ id: 'svc-1', ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }] }],
    resourceBindings: [],
    envVars: [
      { key: 'SECRET_TOKEN', secret: true },
      { key: 'LOG_LEVEL', secret: false }
    ]
  };
  const prisma = {
    deployment: { findUnique: async () => deployment },
    database: {
      findFirst: async () => (opts.existingDb ? { id: 'db-existing', name: 'db' } : null)
    },
    ingress: {
      findFirst: async () =>
        opts.existingIngressOwner === undefined
          ? null
          : { id: 'ing-1', deploymentId: opts.existingIngressOwner }
    }
  };
  const services: Record<string, unknown> = {
    DeploymentsService: {
      updateDeploymentEnvVars: async (_id: string, env: Calls['env']) => {
        calls.env = env;
      },
      updateServiceConfiguration: async (_id: string, _svc: string, changes: unknown) => {
        calls.ports = changes;
      },
      scaleDeployment: async (_id: string, replicas: number) => {
        calls.scaled = replicas;
      }
    },
    DatabasesService: {
      createDatabase: async (_p: string, data: { name: string }) => {
        calls.createdDatabases.push(data.name);
        return { id: `db-${data.name}`, name: data.name };
      }
    },
    IngressService: {
      createProjectIngress: async (_p: string, data: { host: string; deploymentId: string }) => {
        calls.ingress = data;
      }
    }
  };
  const svc = Object.create(ScoreService.prototype) as ScoreService;
  Object.assign(svc, {
    prisma,
    audit: { log: async () => {} },
    logger: { log: () => {}, warn: () => {} },
    repoFiles: {
      readerForDeployment: async () => async (path: string) =>
        path === 'score.yaml' ? SCORE : null
    },
    bindings: {
      bind: async (_id: string, input: { resourceId: string; name: string }) => {
        calls.bound.push({ resourceId: input.resourceId, name: input.name });
        return {};
      }
    },
    moduleRef: { get: (cls: { name: string }) => services[cls.name] }
  });
  return { svc, calls };
}

const actor = { clerkId: 'clerk', userId: 'user-1' };

test('a score file provisions the database, binds it, and writes live references', async () => {
  const { svc, calls } = harness();
  const result = await svc.applyForDeployment('dep-1', actor);
  assert.ok(result);
  assert.deepEqual(calls.createdDatabases, ['db']);
  assert.deepEqual(calls.bound, [{ resourceId: 'db-db', name: 'db' }]);
  assert.deepEqual(calls.env, [
    { key: 'SECRET_TOKEN', value: null, secret: true },
    { key: 'DATABASE_URL', value: '${{resource.db.connection_string}}', secret: false },
    { key: 'LOG_LEVEL', value: 'info', secret: false }
  ]);
  assert.deepEqual(calls.ports, {
    ports: [{ name: 'www', containerPort: 3000, servicePort: 8080, protocol: 'TCP' }]
  });
  assert.equal(calls.scaled, 2);
  assert.deepEqual(calls.ingress, {
    host: 'web.example.com',
    deploymentId: 'dep-1',
    tlsEnabled: true
  });
  assert.equal(result.applied.length, 6);
});

test('an existing database on the project is reused, and a domain owned elsewhere is a warning', async () => {
  const { svc, calls } = harness({ existingDb: true, existingIngressOwner: 'dep-other' });
  const result = await svc.applyForDeployment('dep-1', actor);
  assert.ok(result);
  assert.deepEqual(calls.createdDatabases, []);
  assert.deepEqual(calls.bound, [{ resourceId: 'db-existing', name: 'db' }]);
  assert.equal(calls.ingress, null);
  assert.ok(result.warnings.some((w) => w.includes('already routed')));
});

test('a repository without a score file changes nothing', async () => {
  const { svc, calls } = harness();
  (svc as unknown as { repoFiles: unknown }).repoFiles = {
    readerForDeployment: async () => async () => null
  };
  assert.equal(await svc.applyForDeployment('dep-1', actor), null);
  assert.equal(calls.env, null);
  assert.deepEqual(calls.createdDatabases, []);
});
