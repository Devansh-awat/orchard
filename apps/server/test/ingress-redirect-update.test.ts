import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IngressService } from '../src/projects/ingress.service';

function harness(opts: { createFails?: boolean } = {}) {
  const k8s: string[] = [];
  const updates: any[] = [];
  const svc = Object.create(IngressService.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    prisma: {
      ingress: {
        findFirst: async () => null,
        update: async (args: any) => {
          updates.push(args.data);
          return {};
        }
      }
    },
    access: { assertHostnameAvailable: async () => {} },
    audit: { log: async () => {} },
    k8sNetwork: {
      createIngress: async (args: any) => {
        k8s.push(`create ${args.name} ${args.host}`);
        if (opts.createFails) throw new Error('apiserver said no');
        return { status: {} };
      },
      enableProtectionProxy: async (_ns: string, name: string) => {
        k8s.push(`proxy ${name}`);
        return 'applied';
      },
      deleteIngress: async (_ns: string, name: string) => {
        k8s.push(`delete ${name}`);
      }
    }
  });
  const ingress = {
    id: 'ing-1',
    host: 'old.example.com',
    name: 'midnight-old-example-com-redirect',
    namespace: 'ns',
    redirectTarget: 'https://new.example.com',
    redirectStatus: 307,
    tlsSecretName: 'wildcard-tls'
  };
  const project = {
    id: 'p',
    slug: 'midnight',
    namespace: 'ns',
    organizationId: 'o',
    deployments: []
  };
  const user = { id: 'u', email: 'u@x' };
  return { svc, k8s, updates, ingress, project, user };
}

test('changing the target and status is a single row write with no cluster calls', async () => {
  const { svc, k8s, updates, ingress, project, user } = harness();
  await svc.updateProjectRedirectIngress(
    ingress,
    project,
    { host: 'old.example.com', redirectTarget: 'newer.example.com', redirectStatus: 301 },
    user
  );
  assert.deepEqual(k8s, []);
  assert.deepEqual(updates, [{ redirectTarget: 'https://newer.example.com', redirectStatus: 301 }]);
});

test('renaming the host creates the new ingress before deleting the old and keeps the row', async () => {
  const { svc, k8s, updates, ingress, project, user } = harness();
  await svc.updateProjectRedirectIngress(ingress, project, { host: 'fresh.example.com' }, user);
  assert.deepEqual(k8s, [
    'create midnight-fresh-example-com-redirect fresh.example.com',
    'proxy midnight-fresh-example-com-redirect',
    'delete midnight-old-example-com-redirect'
  ]);
  assert.equal(updates[0].host, 'fresh.example.com');
  assert.equal(updates[0].name, 'midnight-fresh-example-com-redirect');
  assert.equal(updates[0].redirectTarget, 'https://new.example.com');
});

test('a failed create leaves the row and the old ingress untouched', async () => {
  const { svc, k8s, updates, ingress, project, user } = harness({ createFails: true });
  await assert.rejects(
    svc.updateProjectRedirectIngress(ingress, project, { host: 'fresh.example.com' }, user),
    /apiserver said no/
  );
  assert.equal(updates.length, 0);
  assert.ok(!k8s.some((c) => c.startsWith('delete')));
});

test('a rename that would redirect to itself is refused', async () => {
  const { svc, updates, ingress, project, user } = harness();
  await assert.rejects(
    svc.updateProjectRedirectIngress(ingress, project, { host: 'new.example.com' }, user),
    /different from the source domain/
  );
  assert.equal(updates.length, 0);
});

test('a taken host is refused before anything is touched', async () => {
  const { svc, k8s, updates, ingress, project, user } = harness();
  project.deployments = [{ ingresses: [{ id: 'other', host: 'fresh.example.com' }] }] as any;
  await assert.rejects(
    svc.updateProjectRedirectIngress(ingress, project, { host: 'fresh.example.com' }, user),
    /already in use/
  );
  assert.deepEqual(k8s, []);
  assert.equal(updates.length, 0);
});
