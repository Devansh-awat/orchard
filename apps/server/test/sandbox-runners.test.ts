import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MirrorInformer } from '../src/mirror/mirror-informer';
import { buildMirrorShards, stripSecretData } from '../src/mirror/mirror-shards';
import { SandboxMirrorConsumer } from '../src/mirror/consumers/sandbox-mirror.consumer';
import { SandboxRunnerRegistry } from '../src/sandboxes/runners/sandbox-runner.registry';
import { SANDBOX_RUNNERS } from '../src/instance-config/instance-config.sections';
import {
  applyObservation,
  deriveObservedStatus,
  SANDBOX_DISAPPEARED
} from '../src/sandboxes/runners/sandbox-status';
import {
  SandboxSecretsService,
  deriveBoxSecret,
  deriveSandboxSecret,
  sandboxSpecHash
} from '../src/sandboxes/runners/sandbox-secrets';
import {
  KubernetesSandboxRunner,
  SANDBOX_OP_CR,
  SANDBOX_OP_DESTROY,
  SANDBOX_OP_SECRET
} from '../src/sandboxes/runners/kubernetes.runner';
import { SPEC_HASH_ANNOTATION } from '../src/sandboxes/sandbox-cr';
import type { SandboxRef, SandboxRunner } from '../src/sandboxes/runners/sandbox-runner';
import {
  OPENCODE_LOCAL_AUTH,
  OPENCODE_LOCAL_CURL_AUTH
} from '../src/sandboxes/runners/sandbox-init-files';
import { BUSY_SCRIPT } from '../src/sandboxes/runners/sandbox-probes.service';

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    const sql = value as { values?: unknown[]; strings?: unknown[] };
    if (Array.isArray(sql.values)) collectStrings(sql.values, out);
  }
  return out;
}

class FakeMirrorPrisma {
  written: string[] = [];

  k8sObject = { findMany: async () => [] };

  $queryRaw = async () => [];

  $executeRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    this.written.push(...collectStrings(values));
    return 1;
  };

  $transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
}

const SECRET = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    uid: 'secret-uid',
    name: 'sbx-1-auth',
    namespace: 'orchard-sandboxes',
    resourceVersion: '7',
    annotations: { [SPEC_HASH_ANNOTATION]: 'abc123' }
  },
  data: { 'github-token': Buffer.from('ghp_super_secret').toString('base64') },
  stringData: { 'claude-token': 'sk-ant-super-secret' }
};

function secretInformer(prisma: FakeMirrorPrisma, sanitize = true) {
  const informer = new MirrorInformer(
    {} as never,
    prisma as never,
    'sandboxes',
    {
      kind: 'Secret',
      apiVersion: 'v1',
      watchPath: '/api/v1/namespaces/orchard-sandboxes/secrets',
      list: async () => ({
        items: [structuredClone(SECRET)],
        resourceVersion: '9',
        continueToken: null
      }),
      ...(sanitize ? { sanitize: stripSecretData } : {})
    },
    { onListed: () => {}, onWatchEvent: () => {}, onHealthChange: () => {} }
  );
  (informer as any).stopped = false;
  return informer;
}

test('a listed secret reaches k8s_objects without its data', async () => {
  const prisma = new FakeMirrorPrisma();
  await (secretInformer(prisma) as any).runListAndSync(false);
  const manifest = prisma.written.find((s) => s.includes('"kind":"Secret"'));
  assert.ok(manifest, 'the secret manifest was written');
  assert.ok(!manifest.includes('ghp_super_secret'));
  assert.ok(!manifest.includes(Buffer.from('ghp_super_secret').toString('base64')));
  assert.ok(!manifest.includes('sk-ant-super-secret'));
  assert.ok(manifest.includes('abc123'), 'the spec hash annotation is kept');
});

test('a watched secret reaches k8s_objects without its data', async () => {
  const prisma = new FakeMirrorPrisma();
  const informer = secretInformer(prisma) as any;
  informer.dispatch('ADDED', structuredClone(SECRET));
  await informer.drain();
  const manifest = prisma.written.find((s) => s.includes('"kind":"Secret"'));
  assert.ok(manifest);
  assert.ok(!manifest.includes('ghp_super_secret'));
  assert.ok(!manifest.includes('sk-ant-super-secret'));
});

test('without the hook the data would have been stored, so the hook is what protects it', async () => {
  const prisma = new FakeMirrorPrisma();
  await (secretInformer(prisma, false) as any).runListAndSync(false);
  const manifest = prisma.written.find((s) => s.includes('"kind":"Secret"'));
  assert.ok(manifest?.includes('sk-ant-super-secret'));
});

test('the sandbox shard mirrors claims and secrets of this install only, secrets stripped', () => {
  const shards = buildMirrorShards({
    certManager: false,
    sandboxScope: { namespace: 'orchard-sandboxes', instanceId: 'inst-1' },
    namespaceRefs: async () => ({})
  } as never);
  const shard = shards.find((s) => s.name === 'sandboxes')!;
  const kinds = shard.resources.map((r) => r.kind);
  assert.deepEqual(kinds, ['Sandbox', 'Pod', 'PersistentVolumeClaim', 'Secret']);
  for (const resource of shard.resources) {
    assert.equal(resource.labelSelector, 'orchard.my/instance=inst-1');
  }
  const secret = shard.resources.find((r) => r.kind === 'Secret')!;
  assert.equal(secret.watchPath, '/api/v1/namespaces/orchard-sandboxes/secrets');
  assert.equal(secret.sanitize, stripSecretData);
  const stripped = stripSecretData(structuredClone(SECRET));
  assert.equal(stripped.data, undefined);
  assert.equal(stripped.stringData, undefined);
});

test('observations follow the cluster and keep the reason for an intentional stop', () => {
  const ready = { exists: true, status: 'running' as const, message: null };
  const suspended = { exists: true, status: 'stopped' as const, message: null };
  const absent = { exists: false, status: null, message: null };
  assert.deepEqual(
    deriveObservedStatus({ id: 'a', status: 'starting', desiredState: 'running' }, ready),
    { status: 'running', statusMessage: null }
  );
  assert.deepEqual(
    deriveObservedStatus({ id: 'a', status: 'stopping', desiredState: 'stopped' }, suspended),
    { status: 'stopped' }
  );
  assert.deepEqual(
    deriveObservedStatus({ id: 'a', status: 'running', desiredState: 'stopped' }, ready),
    { status: 'stopping' }
  );
  assert.deepEqual(
    deriveObservedStatus({ id: 'a', status: 'stopped', desiredState: 'running' }, suspended),
    { status: 'starting' }
  );
  assert.equal(
    deriveObservedStatus({ id: 'a', status: 'running', desiredState: 'running' }, ready),
    null
  );
  assert.equal(
    deriveObservedStatus({ id: 'a', status: 'creating', desiredState: 'running' }, absent),
    null
  );
  assert.equal(
    deriveObservedStatus({ id: 'a', status: 'deleting', desiredState: 'deleted' }, ready),
    null
  );
  assert.deepEqual(
    deriveObservedStatus({ id: 'a', status: 'running', desiredState: 'running' }, absent),
    { status: 'error', statusMessage: SANDBOX_DISAPPEARED }
  );
  assert.equal(
    deriveObservedStatus(
      { id: 'a', status: 'creating', desiredState: 'running' },
      { exists: true, status: null, message: null }
    ),
    null
  );
});

test('an observation only lands on the row it was derived from', async () => {
  const calls: any[] = [];
  const prisma = {
    sandbox: {
      updateMany: async (args: any) => {
        calls.push(args);
        return { count: 0 };
      }
    }
  };
  const change = await applyObservation(
    prisma,
    { id: 'a', status: 'starting', desiredState: 'running' },
    { exists: true, status: 'running', message: null }
  );
  assert.equal(change, null);
  assert.deepEqual(calls[0].where, { id: 'a', status: 'starting', desiredState: 'running' });
});

function fakeRunner(id: 'kubernetes' | 'vercel', configError: string | null = null): SandboxRunner {
  return {
    id,
    label: id === 'kubernetes' ? 'Kubernetes' : 'Vercel',
    capabilities: {} as never,
    configError: () => configError
  } as unknown as SandboxRunner;
}

function fakeConfig(flags: Record<string, boolean>, values: Record<string, string | null> = {}) {
  return {
    flag: (section: unknown, name: string) => {
      assert.equal(section, SANDBOX_RUNNERS);
      return flags[name] ?? false;
    },
    value: (_section: unknown, name: string) => values[name] ?? null
  };
}

test('the registry describes every runner and picks an available default', () => {
  const registry = new SandboxRunnerRegistry(
    [fakeRunner('kubernetes'), fakeRunner('vercel', 'SANDBOX_VERCEL_TOKEN is not set')],
    fakeConfig(
      { kubernetesEnabled: true, vercelEnabled: true },
      { defaultRunner: 'vercel' }
    ) as never
  );
  const described = registry.describe();
  assert.deepEqual(
    described.runners.map((r) => [r.id, r.available, r.reason]),
    [
      ['kubernetes', true, null],
      ['vercel', false, 'SANDBOX_VERCEL_TOKEN is not set']
    ]
  );
  assert.equal(described.defaultRunner, 'kubernetes');
  assert.equal(registry.resolveForCreate().id, 'kubernetes');
  assert.throws(() => registry.resolveForCreate('vercel'), /SANDBOX_VERCEL_TOKEN/);
  assert.throws(() => registry.resolveForCreate('docker'), /Unknown sandbox runner/);
});

test('a disabled runner refuses new sandboxes but keeps serving the ones it has', () => {
  const registry = new SandboxRunnerRegistry(
    [fakeRunner('kubernetes')],
    fakeConfig({ kubernetesEnabled: false }) as never
  );
  assert.equal(registry.describe().defaultRunner, null);
  assert.throws(() => registry.resolveForCreate(), /turned off/);
  assert.equal(registry.for({ runner: 'kubernetes' }).id, 'kubernetes');
  assert.throws(() => registry.for({ runner: 'vercel' }), /not available/);
});

test('the configured default wins when it is available', () => {
  const registry = new SandboxRunnerRegistry(
    [fakeRunner('kubernetes'), fakeRunner('vercel')],
    fakeConfig(
      { kubernetesEnabled: true, vercelEnabled: true },
      { defaultRunner: 'vercel' }
    ) as never
  );
  assert.equal(registry.describe().defaultRunner, 'vercel');
  assert.equal(registry.resolveForCreate('kubernetes').id, 'kubernetes');
});

test('box secrets are derived per sandbox and per purpose', () => {
  const a = deriveSandboxSecret('opencode-password', 'sbx-a', 'key-1');
  assert.ok(a && a.length >= 40);
  assert.equal(deriveSandboxSecret('opencode-password', 'sbx-a', 'key-1'), a);
  assert.notEqual(deriveSandboxSecret('bridge-token', 'sbx-a', 'key-1'), a);
  assert.notEqual(deriveSandboxSecret('opencode-password', 'sbx-b', 'key-1'), a);
  assert.notEqual(deriveSandboxSecret('opencode-password', 'sbx-a', 'key-2'), a);
  assert.equal(deriveSandboxSecret('opencode-password', 'sbx-a', null), null);
  assert.equal(
    sandboxSpecHash('sbx-a', { b: '2', a: '1' }),
    sandboxSpecHash('sbx-a', { a: '1', b: '2' })
  );
  assert.notEqual(sandboxSpecHash('sbx-a', { a: '1' }), sandboxSpecHash('sbx-a', { a: '2' }));
});

test('a new secret epoch changes the opencode password and bridge token, epoch 0 keeps the old ones', () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'e'.repeat(64);
  try {
    for (const purpose of ['opencode-password', 'bridge-token'] as const) {
      const legacy = deriveSandboxSecret(purpose, 'sbx-a');
      assert.equal(deriveBoxSecret(purpose, 'sbx-a', 0), legacy);
      const one = deriveBoxSecret(purpose, 'sbx-a', 1);
      const two = deriveBoxSecret(purpose, 'sbx-a', 2);
      assert.ok(one && two);
      assert.notEqual(one, legacy);
      assert.notEqual(two, one);
      assert.equal(deriveBoxSecret(purpose, 'sbx-a', 2), two);
      assert.notEqual(deriveBoxSecret(purpose, 'sbx-b', 2), two);
    }
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

test('box secrets are always derived from the epoch stored on the machine', async () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'e'.repeat(64);
  try {
    let epoch = 0;
    const reads: any[] = [];
    const prisma = {
      sandbox: {
        findUnique: async (args: any) => {
          reads.push(args);
          return { secretEpoch: epoch };
        }
      }
    };
    const service = new SandboxSecretsService(prisma as never, {} as never);
    const before = await service.boxSecret('opencode-password', 'sbx-a');
    epoch = 4;
    const after = await service.boxSecret('opencode-password', 'sbx-a');
    assert.equal(before, deriveBoxSecret('opencode-password', 'sbx-a', 0));
    assert.equal(after, deriveBoxSecret('opencode-password', 'sbx-a', 4));
    assert.notEqual(after, before);
    assert.deepEqual(reads[0], { where: { id: 'sbx-a' }, select: { secretEpoch: true } });
    assert.equal(reads.length, 2, 'nothing is cached between calls');
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

const REF: SandboxRef = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  runner: 'kubernetes',
  podName: 'sbx-11111111-1111-4111-8111-111111111111',
  namespace: 'orchard-sandboxes',
  externalId: null,
  runnerState: null
};

const ROW = {
  ...REF,
  status: 'starting',
  desiredState: 'running',
  repoUrl: 'https://github.com/acme/app',
  image: 'debian:bookworm',
  cpuLimit: '2',
  memoryLimit: '4Gi',
  diskSize: '10Gi',
  setupScript: null,
  sshIdentityId: null
};

function k8sRunner(row: Record<string, unknown> | null = ROW) {
  const enqueued: any[] = [];
  const applied: any[] = [];
  const updates: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  const prisma = {
    sandbox: {
      findUnique: async () => row,
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: any) => {
        updates.push({ deleted: args });
        return { count: 1 };
      }
    },
    k8sObject: { findUnique: async () => null }
  };
  const runner = new KubernetesSandboxRunner(
    { kc: {} } as never,
    prisma as never,
    { get: async () => 'inst-1', createIfAbsent: async () => true } as never,
    { enqueue: async (input: any) => enqueued.push(input) } as never,
    {
      registerHandler: (op: string, fn: any) => handlers.set(op, fn),
      ssaApply: async (manifest: any) => {
        applied.push(manifest);
        return {
          ...manifest,
          status: { conditions: [{ type: 'Ready', status: 'True' }] }
        };
      }
    } as never,
    Object.assign(Object.create(SandboxSecretsService.prototype), {
      prisma,
      forSandbox: async () => ({
        authorizedKeys: ['ssh-ed25519 AAAA test'],
        githubToken: 'ghp_token',
        claudeToken: 'sk-ant-token',
        openaiToken: null,
        setupScript: null,
        mcpToken: null,
        opencodePassword: 'pw',
        bridgeToken: 'bt'
      })
    }) as never
  );
  (runner as any).existingCr = async () => null;
  return { runner, enqueued, applied, updates, handlers };
}

test('provisioning queues the infrastructure, the secret and the resource, with no tokens in the queue', async () => {
  const { runner, enqueued } = k8sRunner();
  await runner.requestProvision(REF, REF.userId);
  assert.deepEqual(
    enqueued.map((e) => [e.dedupeKey, e.opType]),
    [
      ['sandboxes:ns', 'ssa'],
      ['sandboxes:netpol', 'ssa'],
      [`sandbox:${REF.id}:secret`, SANDBOX_OP_SECRET],
      [`sandbox:${REF.id}:cr`, SANDBOX_OP_CR]
    ]
  );
  const secretOp = enqueued.find((e) => e.opType === SANDBOX_OP_SECRET);
  assert.deepEqual(secretOp.manifest, { sandboxId: REF.id });
  assert.equal(secretOp.sandboxId, REF.id);
  const queued = JSON.stringify(enqueued);
  assert.ok(!queued.includes('ghp_token') && !queued.includes('sk-ant-token'));
  const netpol = enqueued.find((e) => e.dedupeKey === 'sandboxes:netpol').manifest;
  assert.equal(netpol.kind, 'NetworkPolicy');
});

test('the resource is applied from the row as it is when the op runs, and the row settles', async () => {
  const { runner, applied, updates, handlers } = k8sRunner();
  await handlers.get(SANDBOX_OP_CR)!({ manifest: { sandboxId: REF.id } });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].spec.operatingMode, 'Running');
  assert.equal(applied[0].metadata.labels['orchard.my/instance'], 'inst-1');
  assert.equal(applied[0].metadata.name, REF.podName);
  assert.deepEqual(updates[0], {
    where: { id: REF.id, status: 'starting', desiredState: 'running' },
    data: { status: 'running', statusMessage: null }
  });
  void runner;
});

test('a stop against a resource that is already gone settles the row as stopped', async () => {
  const { runner, applied, updates, handlers } = k8sRunner({
    ...ROW,
    status: 'stopping',
    desiredState: 'stopped'
  });
  (runner as any).patchOperatingMode = async () => null;
  await handlers.get(SANDBOX_OP_CR)!({ manifest: { sandboxId: REF.id } });
  assert.equal(applied.length, 0);
  assert.equal(updates[0].data.status, 'stopped');
  assert.equal(updates[0].where.status, 'stopping');
  assert.equal(updates[0].data.statusMessage, undefined);
});

test('a resource op for a sandbox being deleted does nothing', async () => {
  const { applied, updates, handlers } = k8sRunner({ ...ROW, desiredState: 'deleted' });
  await handlers.get(SANDBOX_OP_CR)!({ manifest: { sandboxId: REF.id } });
  assert.equal(applied.length, 0);
  assert.equal(updates.length, 0);
});

test('destroy refuses a sandbox that was not asked to be deleted', async () => {
  const { runner, updates, handlers } = k8sRunner({ ...ROW, desiredState: 'running' });
  let deleted = false;
  (runner as any).deleteResources = async () => {
    deleted = true;
  };
  await handlers.get(SANDBOX_OP_DESTROY)!({
    manifest: { sandboxId: REF.id, podName: REF.podName }
  });
  assert.equal(deleted, false);
  assert.equal(updates.length, 0);
});

test('the secret is built when the op runs and carries its spec hash', async () => {
  const { runner, updates, handlers } = k8sRunner();
  let created: any = null;
  (runner as any).core = () => ({
    readNamespacedSecret: async () => {
      throw { response: { statusCode: 404 } };
    },
    createNamespacedSecret: async (_ns: string, body: any) => {
      created = body;
    }
  });
  await handlers.get(SANDBOX_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created.metadata.name, `${REF.podName}-auth`);
  assert.equal(created.stringData['github-token'], 'ghp_token');
  const hash = created.metadata.annotations[SPEC_HASH_ANNOTATION];
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(updates[0].data.runnerState.secretHash, hash);
});

test('an existing claim template and its volume mode survive a re-apply', () => {
  const { runner } = k8sRunner();
  const existing = {
    spec: {
      volumeClaimTemplates: [
        {
          metadata: { name: 'home' },
          spec: {
            accessModes: ['ReadWriteOnce'],
            volumeMode: 'Block',
            storageClassName: 'old-class',
            resources: { requests: { storage: '20Gi' } }
          }
        }
      ]
    }
  };
  const prev = process.env.SANDBOX_RUNTIME_CLASS;
  process.env.SANDBOX_RUNTIME_CLASS = 'kata';
  try {
    const cr = runner.buildCr({ ...ROW, setupScript: null } as never, 'inst-1', existing);
    assert.deepEqual(cr.spec.volumeClaimTemplates, existing.spec.volumeClaimTemplates);
    const container = cr.spec.podTemplate.spec.containers[0];
    assert.deepEqual(container.volumeDevices, [{ name: 'home', devicePath: '/dev/sandboxhome' }]);
    assert.equal(container.env.find((e: any) => e.name === 'SANDBOX_HOME_MODE').value, 'block');
    assert.equal(cr.spec.podTemplate.spec.runtimeClassName, 'kata');
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_RUNTIME_CLASS;
    else process.env.SANDBOX_RUNTIME_CLASS = prev;
  }
});

test('a block home never runs as a privileged container without a VM runtime', () => {
  const { runner } = k8sRunner();
  const existing = {
    spec: {
      volumeClaimTemplates: [{ metadata: { name: 'home' }, spec: { volumeMode: 'Block' } }]
    }
  };
  const prevClass = process.env.SANDBOX_RUNTIME_CLASS;
  const prevMode = process.env.SANDBOX_HOME_MODE;
  delete process.env.SANDBOX_RUNTIME_CLASS;
  try {
    assert.throws(
      () => runner.buildCr({ ...ROW, setupScript: null } as never, 'inst-1', existing),
      /SANDBOX_RUNTIME_CLASS/
    );
    process.env.SANDBOX_HOME_MODE = 'block';
    assert.throws(
      () => runner.buildCr({ ...ROW, setupScript: null } as never, 'inst-1', null),
      /SANDBOX_RUNTIME_CLASS/
    );
    delete process.env.SANDBOX_HOME_MODE;
    const cr = runner.buildCr({ ...ROW, setupScript: null } as never, 'inst-1', null);
    assert.equal(cr.spec.podTemplate.spec.containers[0].securityContext, undefined);
  } finally {
    if (prevClass !== undefined) process.env.SANDBOX_RUNTIME_CLASS = prevClass;
    if (prevMode === undefined) delete process.env.SANDBOX_HOME_MODE;
    else process.env.SANDBOX_HOME_MODE = prevMode;
  }
});

test('file writes carry their content on stdin, not in argv', async () => {
  const { runner } = k8sRunner();
  const calls: any[] = [];
  (runner as any).run = async (_ref: SandboxRef, command: string[], opts: any) => {
    calls.push({ command, opts });
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, ok: true };
  };
  const content = Buffer.alloc(300_000, 'x');
  await runner.writeFiles(REF, [{ path: '/persist/home/app/big.txt', content }], {
    asUser: 'dev'
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].command.every((arg: string) => arg.length < 1024));
  assert.equal(calls[0].opts.stdin, content);
  assert.deepEqual(calls[0].command.slice(0, 4), ['su', 'dev', '-s', '/bin/sh']);
});

test('stdin is bounded by length so the command sees end of input', () => {
  const { runner } = k8sRunner();
  const wrapped = (runner as any).wrapCommand(['curl', '--data-binary', '@-'], {
    stdin: Buffer.from('{"a":1}')
  });
  assert.deepEqual(wrapped, [
    '/bin/sh',
    '-c',
    'head -c 7 | "$@"',
    'sh',
    'curl',
    '--data-binary',
    '@-'
  ]);
  assert.throws(
    () => (runner as any).wrapCommand(['true'], { env: { 'BAD NAME': 'x' } }),
    /invalid environment variable/
  );
});

test('the list pass reconciles desired state against the cluster without stepping on open ops', async () => {
  const rows = [
    { ...REF, id: 'a', podName: 'sbx-a', status: 'running', desiredState: 'stopped' },
    { ...REF, id: 'b', podName: 'sbx-b', status: 'running', desiredState: 'running' },
    { ...REF, id: 'c', podName: 'sbx-c', status: 'creating', desiredState: 'running' },
    { ...REF, id: 'd', podName: 'sbx-d', status: 'deleting', desiredState: 'deleted' },
    { ...REF, id: 'e', podName: 'sbx-e', status: 'error', desiredState: 'running' },
    { ...REF, id: 'f', podName: 'sbx-f', status: 'running', desiredState: 'stopped' }
  ];
  const manifests = [
    { name: 'sbx-a', manifest: { spec: { operatingMode: 'Running' } } },
    { name: 'sbx-b', manifest: { spec: { operatingMode: 'Running' } } },
    { name: 'sbx-d', manifest: { spec: { operatingMode: 'Running' } } },
    { name: 'sbx-f', manifest: { spec: { operatingMode: 'Running' } } }
  ];
  const actions: string[] = [];
  const prisma = {
    sandbox: { findMany: async () => rows },
    k8sObject: { findMany: async () => manifests }
  };
  const runner = {
    enqueueCr: async (id: string) => actions.push(`cr:${id}`),
    requestSecretSync: async (ref: SandboxRef) => actions.push(`secret:${ref.id}`),
    requestDestroy: async (ref: SandboxRef) => actions.push(`destroy:${ref.id}`)
  };
  const queue = { hasOpenItem: async (key: string) => key === 'sandbox:f:cr' };
  const consumer = new SandboxMirrorConsumer(prisma as never, runner as never, queue as never);
  await consumer.reconcileDrift(
    ['sbx-a', 'sbx-b', 'sbx-d', 'sbx-f'].map((name) => ({
      namespace: 'orchard-sandboxes',
      name,
      refs: {}
    }))
  );
  assert.deepEqual(actions, ['cr:a', 'secret:c', 'cr:c', 'destroy:d']);
});

test('kubernetes previews are proxied only while a safe preview domain is configured', () => {
  const saved = { cookie: process.env.COOKIE_DOMAIN, frontend: process.env.FRONTEND_URL };
  process.env.COOKIE_DOMAIN = '.orchard.example.com';
  process.env.FRONTEND_URL = 'https://orchard.example.com';
  try {
    let domain: string | null = null;
    let generation = 1;
    const config = {
      get generation() {
        return generation;
      },
      flag: () => true,
      value: (_section: unknown, name: string) => (name === 'previewDomain' ? domain : null)
    };
    const runner = new KubernetesSandboxRunner(
      { kc: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      { registerHandler: () => {} } as never,
      {} as never,
      config as never
    );
    (runner as any).forkProbe.running = true;
    const registry = new SandboxRunnerRegistry([runner], config as never);
    assert.equal(runner.capabilities.previews, 'none');
    domain = 'orchard-preview.dev';
    generation = 2;
    assert.equal(runner.capabilities.previews, 'proxy');
    assert.equal(registry.describe().runners[0].capabilities.previews, 'proxy');
    domain = 'preview.orchard.example.com';
    generation = 3;
    assert.equal(runner.capabilities.previews, 'none');
  } finally {
    if (saved.cookie === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = saved.cookie;
    if (saved.frontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = saved.frontend;
  }
});

test('kubernetes opencode requires its derived password and every server path sends it', async () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'k'.repeat(64);
  try {
    const { runner } = k8sRunner();
    const password = deriveSandboxSecret('opencode-password', REF.id)!;
    const data = runner.secretData({
      authorizedKeys: [],
      githubToken: null,
      claudeToken: null,
      openaiToken: null,
      setupScript: null,
      mcpToken: null,
      opencodePassword: password,
      bridgeToken: null
    } as never);
    assert.equal(data['opencode-password'], password);
    const cr = runner.buildCr({ ...ROW, setupScript: null } as never, 'inst-1', null);
    const init = cr.spec.podTemplate.spec.volumes.find((v: any) => v.name === 'init');
    const item = init.secret.items.find((i: any) => i.key === 'opencode-password');
    assert.equal(item.mode, 0o600);
    (runner as any).resolvePodIp = async () => '10.0.0.9';
    const target: any = await runner.httpTarget(REF, 4096);
    assert.equal(
      target.headers.authorization,
      `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    );
    const other: any = await runner.httpTarget(REF, 3000);
    assert.equal(other.headers.authorization, undefined);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

test('kubernetes httpTarget follows a bumped secret epoch and a sync restarts opencode with it', async () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'k'.repeat(64);
  try {
    const row: Record<string, unknown> = { ...ROW, status: 'running', secretEpoch: 0 };
    const { runner, handlers } = k8sRunner(row);
    (runner as any).resolvePodIp = async () => '10.0.0.9';
    const basic = (pw: string | null) =>
      `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`;
    const old: any = await runner.httpTarget(REF, 4096);
    assert.equal(old.headers.authorization, basic(deriveBoxSecret('opencode-password', REF.id, 0)));
    row.secretEpoch = 1;
    const fresh: any = await runner.httpTarget(REF, 4096);
    assert.equal(
      fresh.headers.authorization,
      basic(deriveBoxSecret('opencode-password', REF.id, 1))
    );
    assert.notEqual(fresh.headers.authorization, old.headers.authorization);
    const execs: Array<{ command: string[]; stdin: string }> = [];
    (runner as any).exec = async (_ref: unknown, command: string[], opts: any) => {
      execs.push({ command, stdin: opts?.stdin?.toString('utf8') ?? '' });
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    };
    (runner as any).secrets.forSandbox = async () => ({
      authorizedKeys: [],
      githubToken: null,
      claudeToken: null,
      openaiToken: null,
      setupScript: null,
      mcpToken: null,
      opencodePassword: deriveBoxSecret('opencode-password', REF.id, 1),
      bridgeToken: null
    });
    const core = {
      readNamespacedSecret: async () => ({}),
      replaceNamespacedSecret: async () => ({}),
      createNamespacedSecret: async () => ({})
    };
    (runner as any).core = () => core;
    (runner as any).instanceId = async () => 'inst-1';
    await handlers.get(SANDBOX_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
    const rotate = execs.find((e) => e.command.join(' ').includes('opencode_password_sync'));
    assert.ok(rotate, 'the secret sync rewrites the password inside the running machine');
    assert.equal(rotate!.command[0], '/bin/bash');
    assert.equal(rotate!.stdin, deriveBoxSecret('opencode-password', REF.id, 1));
    assert.ok(!rotate!.command.join(' ').includes(rotate!.stdin), 'the password never rides argv');
    assert.ok(
      !/opencode serve/.test(rotate!.command.join(' ')),
      'the script cannot match its own pkill pattern'
    );
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

test('in-box calls to opencode read the server password before curling', () => {
  assert.match(OPENCODE_LOCAL_AUTH, /server\.env/);
  assert.match(OPENCODE_LOCAL_CURL_AUTH, /-u/);
  assert.ok(BUSY_SCRIPT.includes(OPENCODE_LOCAL_AUTH));
  assert.ok(BUSY_SCRIPT.includes(OPENCODE_LOCAL_CURL_AUTH));
});
