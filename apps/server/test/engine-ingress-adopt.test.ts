import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  AdoptableIngressRow,
  KnownService,
  planIngressAdoption
} from '../src/engine/consumers/ingress-adoption';
import { IngressConsumer } from '../src/engine/consumers/ingress.consumer';

const OLD = new Date(Date.now() - 60 * 60 * 1000);

const SERVICES: KnownService[] = [
  { id: 'svc-web', name: 'web', deploymentId: 'd1', ports: [80, 8080] },
  { id: 'svc-api', name: 'api', deploymentId: 'd2', ports: [3000] }
];

function row(extra: Partial<AdoptableIngressRow> = {}): AdoptableIngressRow {
  return {
    id: 'i1',
    projectId: 'p1',
    deploymentId: 'd1',
    serviceId: 'svc-web',
    environmentId: null,
    namespace: 'acme',
    name: 'web-example-com',
    host: 'web.example.com',
    path: '/',
    pathType: 'Prefix',
    tlsSecretName: 'orchard-cert-1',
    tlsHosts: ['web.example.com'],
    ingressClass: 'haproxy',
    entrypoints: ['websecure'],
    clusterIssuer: 'letsencrypt-prod',
    annotations: {
      'acme.cert-manager.io/http01-edit-in-place': 'true',
      'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
    },
    statusAddress: null,
    protectionMode: 'none',
    redirectTarget: null,
    servicePort: 80,
    ...extra
  };
}

function written(
  rows: AdoptableIngressRow[],
  backends: Record<string, { name: string; port: number }> = {}
): any {
  const first = rows[0];
  const annotations: Record<string, string> = {};
  for (const [key, value] of Object.entries(first.annotations as Record<string, string>)) {
    if (key !== 'orchard.my/protection') annotations[key] = value;
  }
  return {
    metadata: {
      name: first.name,
      namespace: first.namespace,
      labels: { 'leaf.dev/managed': 'true' },
      annotations
    },
    spec: {
      ingressClassName: first.ingressClass ?? undefined,
      rules: [
        {
          host: first.host,
          http: {
            paths: rows.map((r) => {
              const svc = SERVICES.find((s) => s.id === r.serviceId);
              const backend = backends[r.path] ?? { name: svc?.name, port: r.servicePort };
              return {
                path: r.path,
                pathType: r.pathType,
                backend: { service: { name: backend.name, port: { number: backend.port } } }
              };
            })
          }
        }
      ],
      tls: first.tlsSecretName ? [{ hosts: first.tlsHosts, secretName: first.tlsSecretName }] : []
    }
  };
}

function edit(obj: any, fn: (obj: any) => void): any {
  const copy = JSON.parse(JSON.stringify(obj));
  fn(copy);
  return copy;
}

test('an ingress exactly as orchard wrote it adopts nothing', () => {
  const rows = [row()];
  const plan = planIngressAdoption(written(rows), rows, SERVICES, true);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.creations, []);
  assert.deepEqual(plan.skipped, []);
});

test('host, class, tls secret and allowed annotations are read back', () => {
  const rows = [row({ annotations: { ...(row().annotations as object), 'x-user-note': 'kept' } })];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].host = 'App.Example.com';
    o.spec.ingressClassName = 'cilium';
    o.spec.tls[0].secretName = 'hand-made';
    o.spec.tls[0].hosts = ['app.example.com'];
    o.metadata.annotations['ingress.cilium.io/force-https'] = 'enabled';
    o.metadata.annotations['some.other/annotation'] = 'ignored';
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.equal(plan.updates.length, 1);
  const { data } = plan.updates[0];
  assert.equal(data.host, 'app.example.com');
  assert.equal(data.ingressClass, 'cilium');
  assert.equal(data.tlsSecretName, 'hand-made');
  assert.deepEqual(data.tlsHosts, ['app.example.com']);
  assert.equal(data.entrypoints, undefined);
  assert.deepEqual(data.annotations, {
    'acme.cert-manager.io/http01-edit-in-place': 'true',
    'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
    'x-user-note': 'kept',
    'ingress.cilium.io/force-https': 'enabled'
  });
});

test('dropping tls switches the row to the web entrypoint so the url turns http', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.spec.tls = [];
    delete o.metadata.annotations['cert-manager.io/cluster-issuer'];
    delete o.metadata.annotations['acme.cert-manager.io/http01-edit-in-place'];
  });
  const { data } = planIngressAdoption(obj, rows, SERVICES, true).updates[0];
  assert.equal(data.tlsSecretName, null);
  assert.deepEqual(data.tlsHosts, []);
  assert.deepEqual(data.entrypoints, ['web']);
  assert.equal(data.clusterIssuer, null);
  assert.equal(data.annotations, Prisma.DbNull);
});

test('a host already used by another project is not adopted', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].host = 'taken.example.com';
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, false);
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.skipped.length, 1);
});

test('the basic auth marker is never adopted either way', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.metadata.annotations['orchard.my/basic-auth'] = 'true';
  });
  assert.deepEqual(planIngressAdoption(obj, rows, SERVICES, true).updates, []);

  const marked = [
    row({ annotations: { ...(row().annotations as object), 'orchard.my/basic-auth': 'true' } })
  ];
  const unmarked = edit(written(marked), (o) => {
    delete o.metadata.annotations['orchard.my/basic-auth'];
  });
  assert.deepEqual(planIngressAdoption(unmarked, marked, SERVICES, true).updates, []);
});

test('a backend repointed at a known service port is adopted, deployment included', () => {
  const rows = [row()];
  const obj = written(rows, { '/': { name: 'api', port: 3000 } });
  const { data } = planIngressAdoption(obj, rows, SERVICES, true).updates[0];
  assert.equal(data.serviceId, 'svc-api');
  assert.equal(data.servicePort, 3000);
  assert.equal(data.deploymentId, 'd2');
});

test('a backend orchard does not know is left alone', () => {
  const rows = [row()];
  const plan = planIngressAdoption(
    written(rows, { '/': { name: 'api', port: 9999 } }),
    rows,
    SERVICES,
    true
  );
  assert.deepEqual(plan.updates, []);
  const stranger = planIngressAdoption(
    written(rows, { '/': { name: 'mystery', port: 80 } }),
    rows,
    SERVICES,
    true
  );
  assert.deepEqual(stranger.updates, []);
});

test('protected and redirect ingresses never adopt the proxy as their backend', () => {
  for (const extra of [{ protectionMode: 'password' }, { redirectTarget: 'https://x.dev' }]) {
    const rows = [row(extra)];
    const proxied = written(rows, { '/': { name: 'orchard-protection-proxy', port: 3001 } });
    assert.deepEqual(planIngressAdoption(proxied, rows, SERVICES, true).updates, []);
    const direct = written(rows, { '/': { name: 'api', port: 3000 } });
    assert.deepEqual(planIngressAdoption(direct, rows, SERVICES, true).updates, []);
  }
  const unprotected = [row()];
  const stale = written(unprotected, { '/': { name: 'orchard-protection-proxy', port: 3001 } });
  assert.deepEqual(planIngressAdoption(stale, unprotected, SERVICES, true).updates, []);
});

test('a single path edited in place renames the row', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths[0].path = '/app';
    o.spec.rules[0].http.paths[0].pathType = 'Exact';
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.deepEqual(plan.updates[0].data, { path: '/app', pathType: 'Exact' });
  assert.deepEqual(plan.removals, []);
});

test('a path removed from a shared ingress removes only that row', () => {
  const rows = [
    row(),
    row({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths = o.spec.rules[0].http.paths.filter((p: any) => p.path !== '/api');
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.deepEqual(
    plan.removals.map((r) => r.id),
    ['i2']
  );
  assert.deepEqual(plan.updates, []);
});

test('a path added to a shared ingress gets a row only when it maps to a known service', () => {
  const rows = [
    row(),
    row({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths.push(
      {
        path: '/admin',
        pathType: 'Prefix',
        backend: { service: { name: 'web', port: { number: 8080 } } }
      },
      {
        path: '/elsewhere',
        pathType: 'Prefix',
        backend: { service: { name: 'mystery', port: { number: 80 } } }
      }
    );
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.equal(plan.creations.length, 1);
  const created = plan.creations[0].data;
  assert.equal(created.path, '/admin');
  assert.equal(created.serviceId, 'svc-web');
  assert.equal(created.servicePort, 8080);
  assert.equal(created.deploymentId, 'd1');
  assert.equal(created.name, 'web-example-com');
  assert.equal(created.host, 'web.example.com');
  assert.equal(created.tlsSecretName, 'orchard-cert-1');
  assert.equal(plan.skipped.length, 1);
});

test('extra paths on a single-row ingress stay in the cluster only', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths.push({
      path: '/admin',
      pathType: 'Prefix',
      backend: { service: { name: 'web', port: { number: 8080 } } }
    });
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.deepEqual(plan.creations, []);
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.skipped.length, 1);
});

test('paths that changed in a way orchard cannot pair up are skipped', () => {
  const rows = [
    row(),
    row({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths[0].path = '/one';
    o.spec.rules[0].http.paths[1].path = '/two';
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.creations, []);
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.skipped.length, 1);
});

test('more than one rule leaves routing alone but still adopts tls', () => {
  const rows = [row()];
  const obj = edit(written(rows), (o) => {
    o.spec.rules.push({ host: 'other.example.com', http: { paths: [] } });
    o.spec.tls[0].secretName = 'hand-made';
  });
  const plan = planIngressAdoption(obj, rows, SERVICES, true);
  assert.deepEqual(plan.updates[0].data, { tlsSecretName: 'hand-made' });
});

interface FakeRow extends AdoptableIngressRow {
  updatedAt: Date;
  project: { organizationId: string };
}

function build(opts: {
  rows: FakeRow[];
  building?: number;
  pendingApply?: number;
  taken?: boolean;
}) {
  const updates: { id: string; data: any }[] = [];
  const deleted: string[] = [];
  const created: any[] = [];
  const audits: any[] = [];
  const emitted: any[] = [];
  const prisma = {
    ingress: {
      findMany: async () => opts.rows,
      findFirst: async () => (opts.taken ? { id: 'other' } : null),
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
      },
      delete: async ({ where }: any) => {
        deleted.push(where.id);
      },
      create: async ({ data }: any) => {
        created.push(data);
        return { id: `new-${created.length}` };
      }
    },
    service: {
      findMany: async () =>
        SERVICES.map((s) => ({
          id: s.id,
          name: s.name,
          deploymentId: s.deploymentId,
          port: s.ports[0],
          ports: s.ports.map((port) => ({ port }))
        }))
    },
    deployment: { count: async () => opts.building ?? 0 },
    k8sApplyItem: { count: async () => opts.pendingApply ?? 0 }
  };
  const consumer = new IngressConsumer(
    prisma as any,
    { log: async (entry: any) => audits.push(entry) } as any,
    {} as any,
    { emit: (e: any) => emitted.push(e) } as any
  );
  (consumer as any).confirmAfterMs = 0;
  return { consumer, updates, deleted, created, audits, emitted };
}

const stored = (extra: Partial<AdoptableIngressRow> = {}, updatedAt = OLD): FakeRow => ({
  ...row(extra),
  updatedAt,
  project: { organizationId: 'o1' }
});

test('an adopted edit is written and announced on the deployment', async () => {
  const rows = [stored()];
  const { consumer, updates, emitted } = build({ rows });
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].host = 'app.example.com';
  });
  await consumer.onEvent('update', obj);
  assert.deepEqual(updates, [{ id: 'i1', data: { host: 'app.example.com' } }]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'deployment.changed');
  assert.equal(emitted[0].id, 'd1');
});

test('a removed path needs a second sighting before its row goes', async () => {
  const rows = [
    stored(),
    stored({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const { consumer, deleted, audits } = build({ rows });
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths = o.spec.rules[0].http.paths.filter((p: any) => p.path !== '/api');
  });
  await assert.rejects(consumer.onEvent('update', obj));
  assert.deepEqual(deleted, []);
  await consumer.onEvent('update', obj);
  assert.deepEqual(deleted, ['i2']);
  assert.equal(audits[0].action, 'ingress.deleted');
  assert.equal(audits[0].metadata.reason, 'resource deleted in k8s');
  assert.equal(audits[0].metadata.path, '/api');
});

test('a path that comes back before confirmation keeps its row', async () => {
  const rows = [
    stored(),
    stored({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const { consumer, deleted } = build({ rows });
  const original = written(rows);
  const without = edit(original, (o) => {
    o.spec.rules[0].http.paths = o.spec.rules[0].http.paths.filter((p: any) => p.path !== '/api');
  });
  await assert.rejects(consumer.onEvent('update', without));
  await consumer.onEvent('update', original);
  await assert.rejects(consumer.onEvent('update', without));
  assert.deepEqual(deleted, []);
});

test('a new path is created on the second sighting and audited', async () => {
  const rows = [
    stored(),
    stored({ id: 'i2', path: '/api', serviceId: 'svc-api', deploymentId: 'd2', servicePort: 3000 })
  ];
  const { consumer, created, audits } = build({ rows });
  const obj = edit(written(rows), (o) => {
    o.spec.rules[0].http.paths.push({
      path: '/admin',
      pathType: 'Prefix',
      backend: { service: { name: 'web', port: { number: 8080 } } }
    });
  });
  await assert.rejects(consumer.onEvent('update', obj));
  assert.deepEqual(created, []);
  await consumer.onEvent('update', obj);
  assert.equal(created.length, 1);
  assert.equal(created[0].path, '/admin');
  assert.equal(audits[0].action, 'ingress.created');
});

test('adoption waits while orchard itself is writing', async () => {
  const obj = edit(written([row()]), (o) => {
    o.spec.rules[0].host = 'app.example.com';
  });
  for (const opts of [
    { rows: [stored()], building: 1 },
    { rows: [stored()], pendingApply: 2 },
    { rows: [stored({}, new Date())] }
  ]) {
    const { consumer, updates } = build(opts);
    await assert.rejects(consumer.onEvent('update', obj));
    assert.deepEqual(updates, []);
  }
});

test('an ingress orchard has no rows for is ignored', async () => {
  const { consumer, updates } = build({ rows: [] });
  await consumer.onEvent('update', written([row()]));
  assert.deepEqual(updates, []);
});
