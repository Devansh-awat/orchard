import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  PSQL_APP_NAME,
  PSQL_CONTAINER,
  isStalePsqlPod,
  psqlPodState,
  psqlSessionPod,
  psqlSessionSecret
} from '../src/kubernetes/psql-session';
import { isExecableAppPod } from '../src/kubernetes/pod-exec-policy';
import { shellCommand } from '../src/kubernetes/terminal.gateway';
import { DatabaseShellService, type PsqlClusterPort } from '../src/projects/database-shell.service';

const conn = { host: 'db-rw.ns.svc', port: 5432, user: 'app', password: 'pw', database: 'app' };

function pod(runtimeClassName?: string) {
  return psqlSessionPod({
    name: 'psql-abc',
    namespace: 'tenant-a',
    image: 'ghcr.io/cloudnative-pg/postgresql:17@sha256:x',
    databaseId: 'db1',
    userId: 'u1',
    runtimeClassName,
    ttlSeconds: 600
  });
}

test('manifest is hardened and sandboxed', () => {
  const p = pod('gvisor');
  assert.equal(p.metadata?.namespace, 'tenant-a');
  assert.equal(p.spec?.runtimeClassName, 'gvisor');
  assert.equal(p.spec?.automountServiceAccountToken, false);
  assert.equal(p.spec?.activeDeadlineSeconds, 600);
  assert.equal(p.spec?.restartPolicy, 'Never');
  assert.equal(p.spec?.hostNetwork, undefined);
  assert.equal(p.spec?.serviceAccountName, undefined);
  const c = p.spec!.containers[0];
  assert.equal(c.name, PSQL_CONTAINER);
  assert.equal(c.securityContext?.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext?.capabilities, { drop: ['ALL'] });
  assert.equal(c.securityContext?.readOnlyRootFilesystem, true);
  assert.equal(c.securityContext?.runAsNonRoot, true);
  assert.equal(c.securityContext?.privileged, undefined);
  assert.ok(c.resources?.limits?.memory && c.resources?.limits?.cpu);
  assert.equal(pod().spec?.runtimeClassName, undefined);
});

test('pod carries no credentials itself and no superuser secret', () => {
  const p = pod();
  const c = p.spec!.containers[0];
  assert.deepEqual(c.envFrom, [{ secretRef: { name: 'psql-abc' } }]);
  assert.ok(!JSON.stringify(p).match(/superuser|-app\b|postgres-password|PGPASSWORD/));
  assert.equal(
    p.spec?.volumes?.some((v) => v.secret || v.hostPath),
    false
  );
});

test('secret holds only the app role connection and is owned by the pod', () => {
  const s = psqlSessionSecret({
    name: 'psql-abc',
    namespace: 'tenant-a',
    databaseId: 'db1',
    userId: 'u1',
    connection: conn,
    owner: { name: 'psql-abc', uid: 'uid-1' }
  });
  assert.deepEqual(Object.keys(s.stringData!).sort(), [
    'PGDATABASE',
    'PGHOST',
    'PGPASSWORD',
    'PGPORT',
    'PGUSER'
  ]);
  assert.equal(s.stringData!.PGUSER, 'app');
  assert.equal(s.metadata?.ownerReferences?.[0].uid, 'uid-1');
  assert.equal(s.metadata?.namespace, 'tenant-a');
});

test('labels make the pod exec-able but not a cnpg, pooler or platform pod', () => {
  const labels = pod().metadata!.labels!;
  assert.equal(labels['app.kubernetes.io/name'], PSQL_APP_NAME);
  assert.equal(isExecableAppPod(labels), true);
  assert.ok(!Object.keys(labels).some((k) => k.startsWith('cnpg.io/')));
});

test('exec shell goes straight to psql only when the marker env is set', () => {
  const script = shellCommand('s1')[2];
  assert.match(script, /\$\{ORCHARD_PSQL_SESSION:-\}/);
  assert.ok(script.indexOf('exec psql') < script.indexOf('tmux'));
});

test('pod state', () => {
  assert.equal(psqlPodState({ status: { phase: 'Pending' } }).state, 'pending');
  assert.equal(
    psqlPodState({
      status: {
        phase: 'Pending',
        containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } } as any]
      }
    }).state,
    'failed'
  );
  assert.equal(
    psqlPodState({
      status: { phase: 'Running', containerStatuses: [{ state: { running: {} } } as any] }
    }).state,
    'ready'
  );
});

test('stale detection: deadline, finished, deleted database', () => {
  const base = pod();
  const now = Date.now();
  const live = new Set(['db1']);
  const young = {
    ...base,
    metadata: { ...base.metadata, creationTimestamp: new Date(now) as any }
  };
  assert.equal(isStalePsqlPod(young, now, live, 600), false);
  assert.equal(isStalePsqlPod(young, now, new Set(), 600), true);
  const old = {
    ...base,
    metadata: { ...base.metadata, creationTimestamp: new Date(now - 800_000) as any }
  };
  assert.equal(isStalePsqlPod(old, now, live, 600), true);
  assert.equal(isStalePsqlPod({ ...young, status: { phase: 'Succeeded' } }, now, live, 600), true);
  assert.equal(isStalePsqlPod({ metadata: { labels: {} } }, now, live, 600), false);
});

function harness(opts: { canEdit?: boolean; scopeProject?: string; mode?: string } = {}) {
  const pods = new Map<string, any>();
  const secrets = new Map<string, any>();
  const calls: string[] = [];
  const port: PsqlClusterPort = {
    async createPod(ns, p) {
      calls.push(`createPod:${ns}`);
      const created = {
        ...p,
        metadata: { ...p.metadata, uid: 'uid-' + p.metadata!.name },
        status: {
          phase: 'Running',
          containerStatuses: [{ state: { running: {} } }]
        }
      };
      pods.set(p.metadata!.name!, created);
      return created;
    },
    async createSecret(ns, s) {
      calls.push(`createSecret:${ns}`);
      secrets.set(s.metadata!.name!, s);
    },
    async readPod(_ns, name) {
      return pods.get(name) ?? null;
    },
    async deletePod(_ns, name) {
      pods.delete(name);
      calls.push(`deletePod:${name}`);
    },
    async deleteSecret(_ns, name) {
      secrets.delete(name);
    },
    async listPods() {
      return [...pods.values()];
    }
  };
  const database = {
    id: 'db1',
    name: 'main',
    mode: opts.mode ?? 'cnpg',
    namespace: 'tenant-a',
    pgMajor: 17,
    project: { id: 'p1', organizationId: 'o1' }
  };
  const access = {
    async assertDatabaseEditor(id: string) {
      if (id !== 'db1') throw new NotFoundException('Database not found');
      if (opts.canEdit === false) throw new ForbiddenException('viewer');
      return { user: { id: 'u1', email: 'a@b.c' }, database };
    }
  };
  const prisma: any = {
    project: {
      findFirst: async () => ({ id: opts.scopeProject ?? 'p1', organizationId: 'o1' })
    },
    environment: { findUnique: async () => null },
    database: { findMany: async () => [{ id: 'db1' }] }
  };
  const databases: any = {
    databaseConnection: async () => ({ ...conn }),
    postgresImageFor: (major: number) => `img:${major}`
  };
  const audits: any[] = [];
  const svc = new (class extends DatabaseShellService {
    protected cluster() {
      return port;
    }
    protected delay() {
      return Promise.resolve();
    }
  })(
    prisma,
    access as any,
    databases,
    { kc: {} } as any,
    {
      log: async (a: any) => {
        audits.push(a);
      }
    } as any,
    { isLeader: () => true } as any
  );
  return { svc, pods, secrets, calls, audits };
}

test('open creates pod and secret in the database namespace and audits', async () => {
  const h = harness();
  const s = await h.svc.open('db1', 'clerk');
  assert.equal(s.namespace, 'tenant-a');
  assert.equal(s.container, PSQL_CONTAINER);
  assert.equal(h.pods.size, 1);
  assert.equal(h.secrets.size, 1);
  assert.deepEqual(h.calls.slice(0, 2), ['createPod:tenant-a', 'createSecret:tenant-a']);
  assert.equal(h.audits[0].action, 'database.shell.opened');
});

test('viewer role is denied and nothing is created', async () => {
  const h = harness({ canEdit: false });
  await assert.rejects(() => h.svc.open('db1', 'clerk'), ForbiddenException);
  assert.equal(h.calls.length, 0);
});

test('unknown or cross-project database is not found', async () => {
  const h = harness();
  await assert.rejects(() => h.svc.open('other', 'clerk'), NotFoundException);
  assert.equal(h.calls.length, 0);
});

test('namespace that belongs to a different project is refused', async () => {
  const h = harness({ scopeProject: 'p2' });
  await assert.rejects(() => h.svc.open('db1', 'clerk'), NotFoundException);
  assert.equal(h.calls.length, 0);
});

test('shared databases have no shell', async () => {
  const h = harness({ mode: 'shared' });
  await assert.rejects(() => h.svc.open('db1', 'clerk'), /dedicated/);
  assert.equal(h.calls.length, 0);
});

test('per-database session cap', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.svc.open('db1', 'clerk');
  await assert.rejects(() => h.svc.open('db1', 'clerk'), /Too many/);
});

test('close deletes pod and secret; foreign pods are untouched', async () => {
  const h = harness();
  const s = await h.svc.open('db1', 'clerk');
  h.pods.set('app-pod', { metadata: { name: 'app-pod', labels: {} } });
  await assert.rejects(() => h.svc.close('db1', 'app-pod', 'clerk'), NotFoundException);
  assert.ok(h.pods.has('app-pod'));
  await h.svc.close('db1', s.pod, 'clerk');
  assert.equal(h.pods.has(s.pod), false);
  assert.equal(h.secrets.has(s.pod), false);
});

test('close by a viewer is denied', async () => {
  const h = harness();
  const s = await h.svc.open('db1', 'clerk');
  const v = harness({ canEdit: false });
  v.pods.set(s.pod, h.pods.get(s.pod));
  await assert.rejects(() => v.svc.close('db1', s.pod, 'clerk'), ForbiddenException);
  assert.ok(v.pods.has(s.pod));
});

test('failed startup is cleaned up', async () => {
  const h = harness();
  const orig = h.pods;
  const svc: any = h.svc;
  const port = svc.cluster();
  const create = port.createPod;
  port.createPod = async (ns: string, p: any) => {
    const created = await create(ns, p);
    created.status = {
      phase: 'Pending',
      containerStatuses: [{ state: { waiting: { reason: 'ErrImagePull' } } }]
    };
    return created;
  };
  await assert.rejects(() => h.svc.open('db1', 'clerk'), /could not start/);
  assert.equal(orig.size, 0);
  assert.equal(h.secrets.size, 0);
});

test('sweep removes stale pods', async () => {
  const h = harness();
  await h.svc.open('db1', 'clerk');
  const stale = [...h.pods.values()][0];
  stale.metadata.creationTimestamp = new Date(Date.now() - 10 * 3600_000);
  stale.metadata.namespace = 'tenant-a';
  assert.equal(await h.svc.sweep(), 1);
  assert.equal(h.pods.size, 0);
});
