import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERCEL_BRIDGE_PORT,
  VERCEL_DRIVE_FORK_UNAVAILABLE,
  VERCEL_DRIVE_ROOT,
  VERCEL_INIT_STAGE,
  VERCEL_OPENCODE_PORT,
  VERCEL_OP_DESTROY,
  VERCEL_OP_FORK,
  VERCEL_OP_PROVISION,
  VERCEL_OP_SECRET,
  VERCEL_OP_START,
  VERCEL_OP_STOP,
  VERCEL_PERSIST_ROOT,
  VERCEL_PROVIDER_STOPPED,
  VERCEL_SANDBOX_GONE,
  VercelSandboxRunner,
  exposedPort,
  githubNetworkPolicy,
  VERCEL_HOST_GIT_PLACEHOLDER,
  vercelPorts,
  vercelStatusChange
} from '../src/sandboxes/runners/vercel.runner';
import { stagedInitFiles, opencodeConfigJson } from '../src/sandboxes/runners/sandbox-init-files';
import { SandboxSecretsService, deriveBoxSecret } from '../src/sandboxes/runners/sandbox-secrets';
import { SANDBOX_DRIVE_MARKER, SANDBOX_PHASE_FILE } from '../src/sandboxes/sandbox-bootstrap';
import {
  SANDBOX_BOOTSTRAP_SCRIPT,
  bridgeArchiveName,
  bridgeChecksumsUrl,
  checksumFor,
  defaultBridgeBinaryUrl
} from '../src/sandboxes/sandbox-bootstrap';
import { BridgeChecksumResolver } from '../src/sandboxes/runners/bridge-checksum';
import {
  SandboxConnectService,
  cachedHostKeys,
  parseHostKeys,
  sandboxSshHost
} from '../src/sandboxes/sandbox-connect.service';
import { SandboxNotRunningError } from '../src/sandboxes/runners/sandbox-runner';
import type { SandboxRef, SandboxSecrets } from '../src/sandboxes/runners/sandbox-runner';

process.env.SECRETS_ENCRYPTION_KEY ||= 'test-secrets-key';

const REF: SandboxRef = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  runner: 'vercel',
  podName: 'sbx-33333333-3333-4333-8333-333333333333',
  namespace: null,
  externalId: null,
  runnerState: null
};

const SECRETS: SandboxSecrets = {
  authorizedKeys: ['ssh-ed25519 AAAA owner'],
  githubToken: 'ghp_vercel_secret',
  claudeToken: 'sk-ant-vercel-secret',
  openaiToken: 'sk-openai-secret',
  setupScript: 'echo hi',
  mcpToken: 'mcp-secret',
  opencodePassword: 'opencode-pw',
  bridgeToken: 'bridge-tok'
};

function notFound(): Error {
  return Object.assign(new Error('not found'), { response: { status: 404 } });
}

function apiError(status: number, code: string, message = code): Error {
  return Object.assign(new Error(message), {
    response: { status },
    json: { error: { code, message } }
  });
}

const GIB = 1024 ** 3;

class FakeDrive {
  deletes = 0;
  deleteErrors: Error[] = [];
  forkError: Error | null = null;

  constructor(
    public name: string,
    public region: string,
    public maxSize: number,
    private readonly sdk: FakeSdk
  ) {}

  async fork(params: { name: string }) {
    this.sdk.events.push(`drive.fork ${this.name} -> ${params.name}`);
    if (this.forkError) throw this.forkError;
    const forked = new FakeDrive(params.name, this.region, this.maxSize, this.sdk);
    this.sdk.drives.set(params.name, forked);
    return forked;
  }

  async delete() {
    this.sdk.events.push(`drive.delete ${this.name}`);
    const error = this.deleteErrors.shift();
    if (error) throw error;
    this.deletes += 1;
    this.sdk.drives.delete(this.name);
    this.sdk.deletedDrives.push(this.name);
  }
}

class FakeSdk {
  events: string[] = [];
  drives = new Map<string, FakeDrive>();
  deletedDrives: string[] = [];
  driveCalls: any[] = [];
  driveError: Error | null = null;
  forksAvailable: boolean | Error = true;
  forkProbes = 0;

  addDrive(name: string, region = 'iad1', maxSize = 50 * GIB) {
    const drive = new FakeDrive(name, region, maxSize, this);
    this.drives.set(name, drive);
    return drive;
  }

  async getDrive(params: { name: string }) {
    const drive = this.drives.get(params.name);
    if (!drive) throw notFound();
    return drive;
  }

  async getOrCreateDrive(params: { name: string; region: string; maxSize: number }) {
    this.driveCalls.push({ name: params.name, region: params.region, maxSize: params.maxSize });
    this.events.push(`drive.getOrCreate ${params.name}`);
    if (this.driveError) throw this.driveError;
    const existing = this.drives.get(params.name);
    if (existing) {
      if (existing.region !== params.region || existing.maxSize !== params.maxSize) {
        throw apiError(409, 'conflict', 'already exists with a different maxSizeBytes');
      }
      return existing;
    }
    return this.addDrive(params.name, params.region, params.maxSize);
  }

  async driveForksAvailable() {
    this.forkProbes += 1;
    if (this.forksAvailable instanceof Error) throw this.forksAvailable;
    return this.forksAvailable;
  }
}

class FakeSession {
  writes: { path: string; content: Uint8Array; mode?: number }[] = [];
  commands: any[] = [];
  extended: number[] = [];

  domain(port: number): string {
    return `https://${port}-box.vercel.run`;
  }

  async runCommand(params: any) {
    this.commands.push(params);
    return {
      exitCode: 0,
      wait: async () => ({ exitCode: 0 }),
      stdout: async () => '',
      stderr: async () => '',
      logs: () => ({ async *[Symbol.asyncIterator]() {} }),
      kill: async () => {}
    };
  }

  async writeFiles(files: { path: string; content: Uint8Array; mode?: number }[]) {
    this.writes.push(...files);
  }

  async readFileToBuffer() {
    return null;
  }

  async extendTimeout(ms: number) {
    this.extended.push(ms);
  }
}

class FakeSandbox {
  session = new FakeSession();
  updates: any[] = [];
  stops = 0;
  deletes = 0;
  region = 'iad1';
  mounts: Record<string, { drive: string; mode: string }> | undefined;
  snapshotExpiration: number | undefined;
  keepLastSnapshots: { count: number; expiration?: number } | undefined;
  events: string[] | null = null;

  constructor(
    public name: string,
    public status: string = 'running',
    public expiresAt?: Date
  ) {}

  currentSession() {
    return this.session;
  }

  async stop() {
    this.stops += 1;
    this.status = 'stopped';
    return { status: 'stopped' };
  }

  async delete() {
    this.events?.push(`sandbox.delete ${this.name}`);
    this.deletes += 1;
  }

  async update(params: any) {
    this.events?.push(`sandbox.update ${Object.keys(params).sort().join(',')}`);
    this.updates.push(params);
    if (params.mounts) this.mounts = params.mounts;
    if (params.snapshotExpiration !== undefined)
      this.snapshotExpiration = params.snapshotExpiration;
    if (params.keepLastSnapshots) this.keepLastSnapshots = params.keepLastSnapshots;
  }
}

function vercelRunner(
  row: Record<string, unknown> | null,
  opts: {
    existing?: FakeSandbox | null;
    getError?: Error;
    values?: Record<string, string>;
    rows?: Record<string, Record<string, unknown>>;
    sdk?: FakeSdk;
    sources?: Record<string, FakeSandbox>;
  } = {}
) {
  const enqueued: any[] = [];
  const updates: any[] = [];
  const deleted: any[] = [];
  const created: any[] = [];
  const forked: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  const fake = opts.sdk ?? new FakeSdk();
  const values: Record<string, string> = {
    vercelToken: 'vercel-api-token',
    vercelTeamId: 'team_1',
    vercelProjectId: 'prj_1',
    ...(opts.values ?? {})
  };
  const prisma = {
    sandbox: {
      findUnique: async (args: any) => opts.rows?.[args?.where?.id] ?? row,
      findMany: async () => (row ? [row] : []),
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: any) => {
        deleted.push(args);
        return { count: 1 };
      }
    }
  };
  let existing = opts.existing ?? null;
  const runner = new VercelSandboxRunner(
    prisma as never,
    { generation: 1, value: (_s: unknown, name: string) => values[name] ?? null } as never,
    { get: async () => 'inst-1', createIfAbsent: async () => true } as never,
    { enqueue: async (input: any) => enqueued.push(input) } as never,
    { registerHandler: (op: string, fn: any) => handlers.set(op, fn) } as never,
    Object.assign(Object.create(SandboxSecretsService.prototype), {
      prisma,
      forSandbox: async () => SECRETS
    }) as never
  );
  if (existing) existing.events = fake.events;
  runner.sdk = {
    get: async (params: any) => {
      if (opts.getError) throw opts.getError;
      const source = opts.sources?.[params.name];
      if (source) return source as never;
      if (!existing || params.name !== existing.name) throw notFound();
      fake.events.push(`sandbox.get${params.resume ? ' resume' : ''}`);
      if (params.resume) existing.status = 'running';
      return existing as never;
    },
    create: async (params: any) => {
      fake.events.push('sandbox.create');
      created.push(params);
      existing = new FakeSandbox(params.name);
      existing.events = fake.events;
      existing.region = params.region;
      existing.mounts = params.mounts;
      return existing as never;
    },
    fork: async (params: any) => {
      fake.events.push('sandbox.fork');
      forked.push(params);
      existing = new FakeSandbox(params.name);
      existing.events = fake.events;
      existing.region = params.region;
      existing.mounts = params.mounts;
      return existing as never;
    },
    getDrive: (params: any) => fake.getDrive(params) as never,
    getOrCreateDrive: (params: any) => fake.getOrCreateDrive(params) as never,
    driveForksAvailable: () => fake.driveForksAvailable()
  };
  runner.driveDeletePollMs = 1;
  runner.bridgeChecksums = new BridgeChecksumResolver(
    async () => new Response(`${'ab'.repeat(32)}  ${bridgeArchiveName()}\n`)
  );
  runner.bootPollMs = 1;
  return {
    runner,
    enqueued,
    updates,
    deleted,
    created,
    forked,
    handlers,
    sdk: fake,
    current: () => existing
  };
}

function driveOf(sandboxId: string) {
  return `orchard-${sandboxId}`;
}

const ROW = {
  ...REF,
  status: 'creating',
  desiredState: 'running',
  repoUrl: 'https://github.com/acme/app',
  image: '',
  setupScript: null
};

test('status changes follow what Vercel reports', () => {
  assert.deepEqual(
    vercelStatusChange(
      { id: REF.id, status: 'running', desiredState: 'running' },
      { exists: true, status: 'stopped' }
    ),
    {
      status: 'stopped',
      desiredState: 'stopped',
      statusMessage: VERCEL_PROVIDER_STOPPED,
      startedAt: null
    }
  );
  assert.equal(
    vercelStatusChange(
      { id: REF.id, status: 'running', desiredState: 'running' },
      { exists: true, status: 'running' }
    ),
    null
  );
  assert.equal(
    vercelStatusChange(
      { id: REF.id, status: 'deleting', desiredState: 'deleted' },
      { exists: false, status: null }
    ),
    null
  );
  const gone = vercelStatusChange(
    { id: REF.id, status: 'running', desiredState: 'running' },
    { exists: false, status: null }
  );
  assert.equal(gone?.statusMessage, VERCEL_SANDBOX_GONE);
  assert.deepEqual(
    vercelStatusChange(
      { id: REF.id, status: 'running', desiredState: 'running' },
      { exists: true, status: 'failed' }
    ),
    { status: 'error', statusMessage: 'The Vercel sandbox failed' }
  );
});

test('only the opencode, bridge and allowlisted preview ports are exposed', () => {
  const ports = vercelPorts();
  assert.equal(ports[0], VERCEL_OPENCODE_PORT);
  assert.equal(ports[1], VERCEL_BRIDGE_PORT);
  assert.ok(!ports.includes(22));
  assert.throws(() => vercelPorts([22]), /not an allowed preview port/);
  assert.ok(exposedPort(5173));
  assert.ok(!exposedPort(22));
  assert.ok(!exposedPort(5432));
});

test('the github token rides the network policy, not the box', () => {
  assert.equal(githubNetworkPolicy(null), 'allow-all');
  const policy = githubNetworkPolicy('ghp_x') as any;
  assert.ok(policy.allow['github.com'][0].transform[0].headers.authorization.startsWith('Basic '));
  assert.equal(
    policy.allow['api.github.com'][0].transform[0].headers.authorization,
    'Bearer ghp_x'
  );
});

test('on vercel the host token only replaces the host placeholder, so a guest push keeps its own token', () => {
  const basic = (t: string) => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`;
  const policy = githubNetworkPolicy('ghp_host') as any;
  const [rule] = policy.allow['github.com'];
  assert.equal(policy.allow['github.com'].length, 1);
  assert.deepEqual(rule.match.headers, [
    {
      key: { exact: 'authorization' },
      value: { exact: basic(VERCEL_HOST_GIT_PLACEHOLDER) }
    }
  ]);
  assert.equal(rule.transform[0].headers.authorization, basic('ghp_host'));
  assert.notEqual(rule.match.headers[0].value.exact, basic('ghu_guest'));
  assert.ok(!JSON.stringify(rule.match).includes('ghp_host'));
  const { runner } = vercelRunner(ROW);
  const env = runner.bootstrapEnv(ROW, SECRETS);
  assert.equal(
    env.GIT_TOKEN,
    VERCEL_HOST_GIT_PLACEHOLDER,
    'the box only ever holds the placeholder'
  );
  assert.ok(!JSON.stringify(env).includes('ghp_vercel_secret'));
  assert.equal(runner.bootstrapEnv(ROW, { ...SECRETS, githubToken: null }).GIT_TOKEN, '');
});

test('a guest git exec on vercel carries the token on stdin, never in the command', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { runner } = vercelRunner({ ...ROW, status: 'running' }, { existing: box });
  await runner.exec(REF, ['su', '-l', 'dev', '-c', 'IFS= read -r ORCHARD_GIT_TOKEN; git push'], {
    stdin: Buffer.from('ghu_guest_tok\n')
  });
  const command = box.session.commands.at(-1);
  assert.ok(!JSON.stringify(command).includes('ghu_guest_tok'));
  const staged = box.session.writes.find((w) => w.path.startsWith('/tmp/orchard-stdin-'));
  assert.ok(staged, 'stdin is staged as a file');
  assert.equal(staged!.mode, 0o600);
  assert.match(command.args[1], /rm -f "\$f"/);
  const wrapper = command.args[1];
  assert.ok(
    wrapper.indexOf('rm -f "$f"') < wrapper.indexOf('"$@"'),
    'the staged stdin is removed before the command runs'
  );
  const dir = mkdtempSync(join(tmpdir(), 'orchard-stdin-'));
  const staged2 = join(dir, 'in');
  writeFileSync(staged2, 'hello\n');
  const out = execFileSync('/bin/sh', [
    '-c',
    wrapper,
    'sh',
    staged2,
    'sh',
    '-c',
    'cat; if test -e "$0"; then echo still-there; fi',
    staged2
  ]).toString();
  assert.equal(out, 'hello\n');
});

test('provisioning creates a persistent box with no tokens in create, then stages secrets and bootstraps', async () => {
  const { handlers, created, updates, current } = vercelRunner(ROW);
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created.length, 1);
  const params = created[0];
  assert.equal(params.name, REF.podName);
  assert.equal(params.persistent, true);
  assert.equal(params.image, 'vercel/sandbox/universal');
  assert.deepEqual(params.ports, vercelPorts());
  assert.equal(params.env, undefined);
  const { networkPolicy: _policy, token: _token, ...rest } = params;
  const flat = JSON.stringify(rest);
  for (const secret of [
    'sk-ant-vercel-secret',
    'sk-openai-secret',
    'opencode-pw',
    'bridge-tok',
    'mcp-secret'
  ]) {
    assert.ok(!flat.includes(secret), `${secret} leaked into create()`);
  }
  assert.deepEqual(params.tags, {
    orchard_instance: 'inst-1',
    orchard_sandbox: REF.id,
    orchard_user: REF.userId
  });

  const session = current()!.session;
  const byName = new Map(
    session.writes.map((w) => [w.path.slice(VERCEL_INIT_STAGE.length + 1), w])
  );
  assert.equal(byName.get('opencode-password')?.mode, 0o600);
  assert.equal(byName.get('bridge-token')?.mode, 0o600);
  assert.equal(byName.get('bootstrap.sh')?.mode, 0o644);
  assert.equal(Buffer.from(byName.get('bridge-token')!.content).toString(), 'bridge-tok');
  const phase = session.writes.find((w) => w.path === SANDBOX_PHASE_FILE);
  assert.equal(
    Buffer.from(phase!.content).toString(),
    'starting',
    'a resumed snapshot never reports a stale ready'
  );
  assert.equal(session.commands.length, 1);
  const boot = session.commands[0];
  assert.equal(boot.cmd, 'bash');
  assert.deepEqual(boot.args, [`${VERCEL_INIT_STAGE}/bootstrap.sh`]);
  assert.equal(boot.sudo, true);
  assert.equal(boot.detached, true);
  assert.equal(boot.env.ORCHARD_INIT_STAGE, VERCEL_INIT_STAGE);
  assert.equal(boot.env.SANDBOX_HOME_MODE, 'none');
  assert.equal(boot.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-vercel-secret');
  assert.ok(boot.env.ORCHARD_BRIDGE_URL.startsWith('https://'));
  assert.equal(boot.env.ORCHARD_BRIDGE_SHA256, 'ab'.repeat(32));

  const settled = updates.find((u) => u.data?.status === 'running');
  assert.ok(settled, 'row marked running');
  assert.equal(settled.data.externalId, REF.podName);
});

test('an existing box is resumed and gets the current network policy instead of a new create', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { handlers, created } = vercelRunner(ROW, { existing: box });
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created.length, 0);
  const policies = box.updates.filter((u) => u.networkPolicy);
  assert.equal(policies.length, 1);
  assert.equal(
    policies[0].networkPolicy.allow['api.github.com'][0].transform[0].headers.authorization,
    'Bearer ghp_vercel_secret'
  );
});

test('a secret sync on a running box restages the files and reruns the bootstrap', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { handlers } = vercelRunner({ ...ROW, status: 'running' }, { existing: box });
  await handlers.get(VERCEL_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
  assert.equal(box.updates.length, 1);
  assert.ok(box.session.writes.some((w) => w.path.endsWith('/authorized_keys')));
  assert.equal(box.session.commands.length, 1);
});

test('vercel httpTarget follows a bumped secret epoch and a sync restarts opencode with it', async () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'v'.repeat(64);
  try {
    const box = new FakeSandbox(REF.podName, 'running');
    const row: Record<string, unknown> = { ...ROW, status: 'running', secretEpoch: 0 };
    const { runner, handlers } = vercelRunner(row, { existing: box });
    const basic = (pw: string | null) =>
      `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`;
    const old: any = await runner.httpTarget(REF, VERCEL_OPENCODE_PORT);
    assert.equal(old.headers.authorization, basic(deriveBoxSecret('opencode-password', REF.id, 0)));
    row.secretEpoch = 1;
    const fresh: any = await runner.httpTarget(REF, VERCEL_OPENCODE_PORT);
    assert.equal(
      fresh.headers.authorization,
      basic(deriveBoxSecret('opencode-password', REF.id, 1))
    );
    assert.notEqual(fresh.headers.authorization, old.headers.authorization);
    await handlers.get(VERCEL_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
    const staged = (name: string) =>
      box.session.writes.find((w) => w.path === `${VERCEL_INIT_STAGE}/${name}`);
    assert.equal(staged('opencode-password')?.mode, 0o600);
    assert.equal(staged('bridge-token')?.mode, 0o600);
    const bootstrap = Buffer.from(staged('bootstrap.sh')!.content).toString('utf8');
    assert.match(bootstrap, /opencode_password_sync < \/orchard-init\/opencode-password/);
    assert.match(bootstrap, /pkill -f '\[o\]pencode serve'/);
    assert.match(bootstrap, /--token-file \/orchard-init\/bridge-token/);
    assert.equal(box.session.commands.length, 1);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

test('a secret sync on a stopped box only updates the policy', async () => {
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { handlers } = vercelRunner(
    { ...ROW, status: 'stopped', desiredState: 'stopped' },
    { existing: box }
  );
  await handlers.get(VERCEL_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
  assert.equal(box.updates.length, 1);
  assert.equal(box.session.writes.length, 0);
});

test('destroy refuses a sandbox that was not asked to be deleted', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { handlers, deleted } = vercelRunner({ ...ROW, status: 'running' }, { existing: box });
  await handlers.get(VERCEL_OP_DESTROY)!({ manifest: { sandboxId: REF.id } });
  assert.equal(box.deletes, 0);
  assert.equal(deleted.length, 0);
});

test('destroy deletes the box and its row once it is marked deleted', async () => {
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { handlers, deleted } = vercelRunner(
    { ...ROW, status: 'deleting', desiredState: 'deleted' },
    { existing: box }
  );
  await handlers.get(VERCEL_OP_DESTROY)!({ manifest: { sandboxId: REF.id } });
  assert.equal(box.deletes, 1);
  assert.equal(deleted.length, 1);
});

test('a Vercel API outage during polling leaves rows alone', async () => {
  const { runner, updates } = vercelRunner(
    { ...ROW, status: 'running' },
    { getError: Object.assign(new Error('boom'), { response: { status: 503 } }) }
  );
  await runner.reconcile([REF]);
  assert.equal(updates.length, 0);
  assert.equal(await runner.canTrustAbsence(), false);
});

test('a box stopped by the provider timeout is recorded as stopped on purpose', async () => {
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { runner, updates } = vercelRunner({ ...ROW, status: 'running' }, { existing: box });
  await runner.reconcile([REF]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.statusMessage, VERCEL_PROVIDER_STOPPED);
  assert.equal(updates[0].data.desiredState, 'stopped');
});

test('missing credentials are reported without exposing the token', () => {
  const { runner } = vercelRunner(ROW, { values: { vercelToken: '' } });
  assert.match(runner.configError() ?? '', /SANDBOX_VERCEL_TOKEN/);
});

test('mcp is left out of opencode config when the box could not reach it', () => {
  const internal = JSON.parse(
    opencodeConfigJson('tok', {
      mcpUrl: 'http://orchard.svc.cluster.local/mcp',
      requireHttpsMcp: true
    })
  );
  assert.equal(internal.mcp, undefined);
  const pub = JSON.parse(
    opencodeConfigJson('tok', { mcpUrl: 'https://orchard.example.com/mcp', requireHttpsMcp: true })
  );
  assert.equal(pub.mcp.orchard.headers.Authorization, 'Bearer tok');
  const files = stagedInitFiles(SECRETS, { mcpUrl: 'https://o.example/mcp' });
  assert.equal(files.authorized_keys, 'ssh-ed25519 AAAA owner\n');
  assert.equal(files['bootstrap.sh'], SANDBOX_BOOTSTRAP_SCRIPT);
});

test('the bootstrap script parses as bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-bootstrap-'));
  const path = join(dir, 'bootstrap.sh');
  writeFileSync(path, SANDBOX_BOOTSTRAP_SCRIPT);
  execFileSync('bash', ['-n', path]);
});

test('host keys are parsed, deduplicated and sorted, ignoring junk', () => {
  const keys = parseHostKeys(
    [
      'ssh-rsa AAAAB3Nza root@box',
      'ssh-ed25519 AAAAC3Nz root@box',
      'ssh-ed25519 AAAAC3Nz again',
      'not a key',
      'ssh-ed25519 $(rm -rf /)',
      ''
    ].join('\n')
  );
  assert.deepEqual(keys, ['ssh-ed25519 AAAAC3Nz', 'ssh-rsa AAAAB3Nza']);
  assert.deepEqual(cachedHostKeys({ hostKeys: ['a', 1, 'b'] }), ['a', 'b']);
  assert.deepEqual(cachedHostKeys(null), []);
  assert.equal(sandboxSshHost('box'), 'orchard-box');
});

function connectService(
  exec: () => Promise<{ stdout: string }>,
  runnerState: Record<string, unknown> = {}
) {
  const updates: any[] = [];
  const prisma = {
    sandbox: {
      findUnique: async () => ({ runnerState }),
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      }
    },
    sshIdentity: { count: async () => 2 }
  };
  const registry = { for: () => ({ exec }) };
  return { service: new SandboxConnectService(prisma as never, registry as never), updates };
}

test('host keys come from the running box and are remembered for when it is stopped', async () => {
  const { service, updates } = connectService(
    async () => ({
      stdout: 'ssh-ed25519 AAAAC3Nz root@box\n'
    }),
    { expiresAt: 'x' }
  );
  const fresh = await service.hostKeys({ ...REF, status: 'running' } as never);
  assert.deepEqual(fresh.publicKeys, ['ssh-ed25519 AAAAC3Nz']);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data.runnerState, {
    expiresAt: 'x',
    hostKeys: ['ssh-ed25519 AAAAC3Nz']
  });

  const stopped = await service.hostKeys({
    ...REF,
    status: 'stopped',
    runnerState: { hostKeys: ['ssh-ed25519 CACHED'] }
  } as never);
  assert.deepEqual(stopped.publicKeys, ['ssh-ed25519 CACHED']);
});

test('a box that cannot be reached falls back to the remembered host keys', async () => {
  const { service, updates } = connectService(async () => {
    throw new SandboxNotRunningError();
  });
  const res = await service.hostKeys({
    ...REF,
    status: 'running',
    runnerState: { hostKeys: ['ssh-ed25519 CACHED'] }
  } as never);
  assert.deepEqual(res.publicKeys, ['ssh-ed25519 CACHED']);
  assert.equal(updates.length, 0);
});

test('connect info names the ssh host and says whether a key is registered', async () => {
  const { service } = connectService(async () => ({ stdout: '' }));
  assert.deepEqual(await service.connectInfo({ name: 'box', userId: REF.userId }), {
    sshHost: 'orchard-box',
    user: 'dev',
    sshReady: true
  });
});

test('the bridge checksum comes from the pinned release and is cached', async () => {
  const calls: string[] = [];
  const resolver = new BridgeChecksumResolver(async (url) => {
    calls.push(url);
    return new Response(
      [
        `${'11'.repeat(32)}  orchard_0.9.0_darwin_arm64.tar.gz`,
        `${'AB'.repeat(32)}  orchard_0.9.0_linux_amd64.tar.gz`
      ].join('\n')
    );
  }, '0.9.0');
  const url = defaultBridgeBinaryUrl('0.9.0');
  assert.equal(await resolver.resolve(url, null), 'ab'.repeat(32));
  assert.equal(await resolver.resolve(url, null), 'ab'.repeat(32));
  assert.deepEqual(calls, [bridgeChecksumsUrl('0.9.0')]);
  assert.equal(await resolver.resolve('https://mirror.example.com/orchard.tar.gz', null), null);
  assert.equal(
    await resolver.resolve('https://mirror.example.com/orchard.tar.gz', 'CD'.repeat(32)),
    'cd'.repeat(32)
  );
  assert.equal(await resolver.resolve(url, 'not-a-sha'), null);
  const failing = new BridgeChecksumResolver(
    async () => new Response('', { status: 404 }),
    '0.9.0'
  );
  assert.equal(await failing.resolve(url, null), null);
  assert.equal(
    checksumFor(`${'ef'.repeat(32)} *orchard_x.tar.gz`, 'orchard_x.tar.gz'),
    'ef'.repeat(32)
  );
});

test('an overridden bridge url needs a pinned checksum, which reaches the bootstrap', async () => {
  const { runner } = vercelRunner(ROW, {
    values: { bridgeBinaryUrl: 'https://mirror.example.com/orchard.tar.gz' }
  });
  assert.match(runner.configError() ?? '', /bridgeBinarySha256/);
  const pinned = vercelRunner(ROW, {
    values: {
      bridgeBinaryUrl: 'https://mirror.example.com/orchard.tar.gz',
      bridgeBinarySha256: 'CD'.repeat(32)
    }
  }).runner;
  assert.equal(pinned.configError(), null);
  const sha = await pinned.bridgeSha256();
  const env = pinned.bootstrapEnv(ROW, SECRETS, sha);
  assert.equal(env.ORCHARD_BRIDGE_URL, 'https://mirror.example.com/orchard.tar.gz');
  assert.equal(env.ORCHARD_BRIDGE_SHA256, 'cd'.repeat(32));
  assert.equal(runner.bootstrapEnv(ROW, SECRETS).ORCHARD_BRIDGE_SHA256, undefined);
});

test('the bootstrap refuses an unverified bridge and checks the archive hash', () => {
  assert.match(
    SANDBOX_BOOTSTRAP_SCRIPT,
    /if \[ -n "\$bridge_source" \] && \[ -z "\$bridge_sha" \]; then\n\s+log "no ORCHARD_BRIDGE_SHA256/
  );
  assert.match(SANDBOX_BOOTSTRAP_SCRIPT, /sha256sum -c -/);
  assert.match(SANDBOX_BOOTSTRAP_SCRIPT, /"\$bridge_source \$bridge_sha" > "\$bridge_marker"/);
});

test('the bridge is picked for the machine architecture with a checksum for each', async () => {
  const { runner } = vercelRunner(ROW);
  runner.bridgeChecksums = new BridgeChecksumResolver(
    async () =>
      new Response(
        `${'ab'.repeat(32)}  ${bridgeArchiveName()}\n${'ef'.repeat(32)}  ${bridgeArchiveName(undefined, 'arm64')}\n`
      )
  );
  const arm = await runner.bridgeArm64();
  assert.deepEqual(arm, { url: defaultBridgeBinaryUrl(undefined, 'arm64'), sha: 'ef'.repeat(32) });
  assert.match(arm!.url, /linux_arm64\.tar\.gz$/);
  const env = runner.bootstrapEnv(ROW, SECRETS, await runner.bridgeSha256(), arm);
  assert.equal(env.ORCHARD_BRIDGE_SHA256, 'ab'.repeat(32));
  assert.equal(env.ORCHARD_BRIDGE_URL_ARM64, arm!.url);
  assert.equal(env.ORCHARD_BRIDGE_SHA256_ARM64, 'ef'.repeat(32));
  const custom = vercelRunner(ROW, {
    values: {
      bridgeBinaryUrl: 'https://mirror.example.com/orchard.tar.gz',
      bridgeBinarySha256: 'cd'.repeat(32)
    }
  }).runner;
  assert.equal(await custom.bridgeArm64(), null);
  assert.match(SANDBOX_BOOTSTRAP_SCRIPT, /case "\$\(uname -m\)" in/);
  assert.match(SANDBOX_BOOTSTRAP_SCRIPT, /ORCHARD_BRIDGE_SHA256_ARM64/);
});

test('a new machine gets its own drive in its region, mounted read-write, and snapshots that never expire', async () => {
  const { handlers, created, updates, sdk, current } = vercelRunner(ROW);
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.deepEqual(sdk.driveCalls, [{ name: driveOf(REF.id), region: 'iad1', maxSize: 50 * GIB }]);
  const params = created[0];
  assert.equal(params.region, 'iad1');
  assert.deepEqual(params.mounts, {
    [VERCEL_DRIVE_ROOT]: { drive: driveOf(REF.id), mode: 'read-write' }
  });
  assert.equal(params.snapshotExpiration, 0);
  assert.deepEqual(params.keepLastSnapshots, { count: 3, expiration: 0 });
  assert.ok(
    sdk.events.indexOf(`drive.getOrCreate ${driveOf(REF.id)}`) <
      sdk.events.indexOf('sandbox.create')
  );
  const recorded = updates.find((u) => u.data?.runnerState?.driveName);
  assert.equal(recorded?.data.runnerState.driveName, driveOf(REF.id));
  const boot = current()!.session.commands[0];
  assert.equal(boot.env.SANDBOX_DRIVE_ROOT, VERCEL_DRIVE_ROOT);
  assert.equal(boot.env.SANDBOX_PERSIST_ROOT, VERCEL_PERSIST_ROOT);
});

test('vercelDriveGiB sizes new drives and 0 keeps homes in never-expiring snapshots', async () => {
  const sized = vercelRunner(ROW, { values: { vercelDriveGiB: '120' } });
  await sized.handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(sized.sdk.driveCalls[0].maxSize, 120 * GIB);

  const off = vercelRunner(ROW, { values: { vercelDriveGiB: '0' } });
  await off.handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(off.sdk.driveCalls.length, 0);
  assert.equal(off.created[0].mounts, undefined);
  assert.equal(off.created[0].snapshotExpiration, 0);
  assert.equal(off.current()!.session.commands[0].env.SANDBOX_DRIVE_ROOT, undefined);
});

test('an existing machine gets its drive and snapshot retention before it resumes', async () => {
  const box = new FakeSandbox(REF.podName, 'stopped');
  box.region = 'sfo1';
  const { handlers, created, sdk } = vercelRunner(
    { ...ROW, status: 'starting' },
    { existing: box }
  );
  await handlers.get(VERCEL_OP_START)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created.length, 0);
  assert.deepEqual(sdk.driveCalls, [{ name: driveOf(REF.id), region: 'sfo1', maxSize: 50 * GIB }]);
  const prepare = box.updates[0];
  assert.deepEqual(prepare.mounts, {
    [VERCEL_DRIVE_ROOT]: { drive: driveOf(REF.id), mode: 'read-write' }
  });
  assert.equal(prepare.snapshotExpiration, 0);
  assert.deepEqual(prepare.keepLastSnapshots, { count: 3, expiration: 0 });
  assert.ok(
    sdk.events.indexOf('sandbox.update keepLastSnapshots,mounts,snapshotExpiration') <
      sdk.events.indexOf('sandbox.get resume'),
    sdk.events.join(' | ')
  );
  assert.equal(box.session.commands[0].env.SANDBOX_DRIVE_ROOT, VERCEL_DRIVE_ROOT);
});

test('a machine with its drive mounted keeps it, even after the configured size changes', async () => {
  const box = new FakeSandbox(REF.podName, 'stopped');
  box.mounts = { [VERCEL_DRIVE_ROOT]: { drive: 'orchard-existing', mode: 'read-write' } };
  box.snapshotExpiration = 0;
  box.keepLastSnapshots = { count: 3, expiration: 0 };
  const sdk = new FakeSdk();
  sdk.addDrive('orchard-existing', 'iad1', 50 * GIB);
  const { handlers, updates } = vercelRunner(
    { ...ROW, status: 'starting', runnerState: { driveName: 'orchard-existing' } },
    { existing: box, sdk, values: { vercelDriveGiB: '200' } }
  );
  await handlers.get(VERCEL_OP_START)!({ manifest: { sandboxId: REF.id } });
  assert.deepEqual(
    box.updates.map((u) => Object.keys(u)),
    [['networkPolicy']]
  );
  assert.equal(sdk.drives.get('orchard-existing')?.maxSize, 50 * GIB);
  assert.ok(
    updates
      .filter((u) => u.data?.runnerState)
      .every((u) => u.data.runnerState.driveName === 'orchard-existing')
  );
  assert.equal(box.session.commands[0].env.SANDBOX_DRIVE_ROOT, VERCEL_DRIVE_ROOT);
});

test('a team without drives falls back to never-expiring snapshots and says so once', async () => {
  const sdk = new FakeSdk();
  sdk.driveError = apiError(403, 'forbidden', 'Drives are not available on this plan');
  const { runner, handlers, created } = vercelRunner(ROW, { sdk });
  const warnings: string[] = [];
  (runner as any).logger = { warn: (m: string) => warnings.push(m), log() {}, error() {} };
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created[0].mounts, undefined);
  assert.equal(created[0].snapshotExpiration, 0);
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(sdk.driveCalls.length, 1, 'no new drive attempt within the hour');
  assert.equal(warnings.filter((w) => /drives are unavailable/i.test(w)).length, 1);
  assert.match(warnings[0], /403 Drives are not available on this plan/);
});

test('a machine that already has a drive never silently drops it', async () => {
  const sdk = new FakeSdk();
  sdk.driveError = apiError(403, 'forbidden');
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { handlers } = vercelRunner(
    { ...ROW, status: 'starting', runnerState: { driveName: driveOf(REF.id) } },
    { existing: box, sdk }
  );
  await assert.rejects(handlers.get(VERCEL_OP_START)!({ manifest: { sandboxId: REF.id } }));
  assert.equal(box.status, 'stopped');
});

test('a machine whose sandbox vanished comes back on a new sandbox with the same drive', async () => {
  const sdk = new FakeSdk();
  sdk.addDrive(driveOf(REF.id), 'cdg1', 50 * GIB);
  const { handlers, created } = vercelRunner(
    { ...ROW, status: 'starting', runnerState: { driveName: driveOf(REF.id) } },
    { sdk }
  );
  await handlers.get(VERCEL_OP_START)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created[0].region, 'cdg1');
  assert.deepEqual(created[0].mounts, {
    [VERCEL_DRIVE_ROOT]: { drive: driveOf(REF.id), mode: 'read-write' }
  });
});

test('destroy deletes the drive after the sandbox is gone, retrying while it is still attached', async () => {
  const sdk = new FakeSdk();
  const drive = sdk.addDrive(driveOf(REF.id));
  drive.deleteErrors = [
    apiError(409, 'drive_attached', 'Drive is attached to a sandbox'),
    apiError(409, 'drive_attached', 'Drive is attached to a sandbox')
  ];
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { handlers, deleted } = vercelRunner(
    {
      ...ROW,
      status: 'deleting',
      desiredState: 'deleted',
      runnerState: { driveName: driveOf(REF.id) }
    },
    { existing: box, sdk }
  );
  await handlers.get(VERCEL_OP_DESTROY)!({ manifest: { sandboxId: REF.id } });
  assert.equal(box.deletes, 1);
  assert.deepEqual(sdk.deletedDrives, [driveOf(REF.id)]);
  assert.ok(
    sdk.events.indexOf(`sandbox.delete ${REF.podName}`) <
      sdk.events.indexOf(`drive.delete ${driveOf(REF.id)}`)
  );
  assert.equal(sdk.events.filter((e) => e.startsWith('drive.delete')).length, 3);
  assert.equal(deleted.length, 1);
});

test('destroy keeps the row when the drive cannot be deleted, so the retry still knows the drive', async () => {
  const sdk = new FakeSdk();
  const drive = sdk.addDrive('orchard-custom');
  drive.deleteErrors = [apiError(500, 'internal')];
  const box = new FakeSandbox(REF.podName, 'stopped');
  const { handlers, deleted } = vercelRunner(
    {
      ...ROW,
      status: 'deleting',
      desiredState: 'deleted',
      runnerState: { driveName: 'orchard-custom' }
    },
    { existing: box, sdk }
  );
  await assert.rejects(handlers.get(VERCEL_OP_DESTROY)!({ manifest: { sandboxId: REF.id } }));
  assert.equal(deleted.length, 0);
  assert.equal(drive.deletes, 0);
});

test('only destroy deletes drives: stop, start, secret sync, reconcile and a refused destroy leave them', async () => {
  const sdk = new FakeSdk();
  const drive = sdk.addDrive(driveOf(REF.id));
  const box = new FakeSandbox(REF.podName, 'running');
  const row: Record<string, unknown> = {
    ...ROW,
    status: 'running',
    runnerState: { driveName: driveOf(REF.id) }
  };
  const { runner, handlers } = vercelRunner(row, { existing: box, sdk });
  await handlers.get(VERCEL_OP_SECRET)!({ manifest: { sandboxId: REF.id } });
  await runner.reconcile([REF]);
  await handlers.get(VERCEL_OP_DESTROY)!({ manifest: { sandboxId: REF.id } });
  row.desiredState = 'stopped';
  row.status = 'stopping';
  await handlers.get(VERCEL_OP_STOP)!({ manifest: { sandboxId: REF.id } });
  row.desiredState = 'running';
  row.status = 'starting';
  await handlers.get(VERCEL_OP_START)!({ manifest: { sandboxId: REF.id } });
  assert.equal(drive.deletes, 0);
  assert.ok(!sdk.events.some((e) => e.startsWith('drive.delete')));
});

test('reconcile gives a running legacy box the never-expiring retention without resuming anything', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { runner, sdk } = vercelRunner({ ...ROW, status: 'running' }, { existing: box });
  await runner.reconcile([REF]);
  assert.deepEqual(box.updates, [
    { snapshotExpiration: 0, keepLastSnapshots: { count: 3, expiration: 0 } }
  ]);
  assert.ok(!sdk.events.includes('sandbox.get resume'));
  await runner.reconcile([REF]);
  assert.equal(box.updates.length, 1);
});

const FORK_ID = '55555555-5555-4555-8555-555555555555';
const SOURCE_POD = 'sbx-source';

function forkRows(sourceState: Record<string, unknown>) {
  const target = {
    ...ROW,
    id: FORK_ID,
    podName: `sbx-${FORK_ID}`,
    runnerState: { forkFrom: { sandboxId: REF.id, podName: SOURCE_POD } }
  };
  const source = { ...ROW, status: 'stopped', runnerState: sourceState };
  return { target, rows: { [FORK_ID]: target, [REF.id]: source } };
}

test('a fork gets a fork of the source drive, mounted where the source had it', async () => {
  const sdk = new FakeSdk();
  sdk.addDrive('orchard-source', 'iad1');
  const { target, rows } = forkRows({ driveName: 'orchard-source' });
  const sourceBox = new FakeSandbox(SOURCE_POD, 'stopped');
  const { handlers, forked, updates } = vercelRunner(target, {
    rows,
    sdk,
    sources: { [SOURCE_POD]: sourceBox }
  });
  await handlers.get(VERCEL_OP_FORK)!({
    manifest: { sandboxId: FORK_ID, sourceSandboxId: REF.id }
  });
  assert.ok(sdk.events.includes(`drive.fork orchard-source -> ${driveOf(FORK_ID)}`));
  assert.equal(forked.length, 1);
  assert.equal(forked[0].sourceSandbox, SOURCE_POD);
  assert.deepEqual(forked[0].mounts, {
    [VERCEL_DRIVE_ROOT]: { drive: driveOf(FORK_ID), mode: 'read-write' }
  });
  assert.equal(forked[0].snapshotExpiration, 0);
  assert.equal(
    updates.find((u) => u.data?.runnerState?.driveName)?.data.runnerState.driveName,
    driveOf(FORK_ID)
  );
  assert.ok(sdk.drives.has('orchard-source'), 'the source drive is untouched');
});

test('a fork fails clearly when the plan has no drive forks, and the runner stops offering forks', async () => {
  const sdk = new FakeSdk();
  const source = sdk.addDrive('orchard-source', 'iad1');
  source.forkError = apiError(403, 'forbidden', 'Drive forking is in private beta.');
  const { target, rows } = forkRows({ driveName: 'orchard-source' });
  const { runner, handlers, forked, updates } = vercelRunner(target, {
    rows,
    sdk,
    sources: { [SOURCE_POD]: new FakeSandbox(SOURCE_POD, 'stopped') }
  });
  await assert.rejects(
    handlers.get(VERCEL_OP_FORK)!({ manifest: { sandboxId: FORK_ID, sourceSandboxId: REF.id } }),
    (e: any) => e.message === VERCEL_DRIVE_FORK_UNAVAILABLE && e.statusCode === 422
  );
  assert.equal(forked.length, 0);
  const failed = updates.find((u) => u.data?.status === 'error');
  assert.equal(failed?.data.statusMessage, VERCEL_DRIVE_FORK_UNAVAILABLE);
  assert.equal(runner.capabilities.fork, false);
  assert.equal(
    await runner.forkSupport({ ...REF, runnerState: { driveName: 'orchard-source' } }),
    VERCEL_DRIVE_FORK_UNAVAILABLE
  );
});

test('fork support comes from the drive fork probe and only matters for machines with a drive', async () => {
  const sdk = new FakeSdk();
  sdk.forksAvailable = false;
  const { runner } = vercelRunner(ROW, { sdk });
  assert.equal(await runner.forkSupport(REF), null);
  assert.equal(
    await runner.forkSupport({ ...REF, runnerState: { driveName: driveOf(REF.id) } }),
    VERCEL_DRIVE_FORK_UNAVAILABLE
  );
  assert.equal(runner.capabilities.fork, false);
  assert.equal(sdk.forkProbes, 1, 'the probe result is cached');

  const yes = vercelRunner(ROW);
  assert.equal(
    await yes.runner.forkSupport({ ...REF, runnerState: { driveName: driveOf(REF.id) } }),
    null
  );
  assert.equal(yes.runner.capabilities.fork, true);

  const off = vercelRunner(ROW, { values: { vercelDriveGiB: '0' } });
  off.sdk.forksAvailable = false;
  assert.equal(off.runner.capabilities.fork, true);
  assert.equal(off.sdk.forkProbes, 0);
});

test('a fork of a machine without a drive is a snapshot fork that gets its own fresh drive', async () => {
  const sdk = new FakeSdk();
  const { target, rows } = forkRows({});
  const sourceBox = new FakeSandbox(SOURCE_POD, 'stopped');
  sourceBox.region = 'fra1';
  const { handlers, forked, current } = vercelRunner(target, {
    rows,
    sdk,
    sources: { [SOURCE_POD]: sourceBox }
  });
  await handlers.get(VERCEL_OP_FORK)!({
    manifest: { sandboxId: FORK_ID, sourceSandboxId: REF.id }
  });
  assert.ok(!sdk.events.some((e) => e.startsWith('drive.fork')));
  assert.deepEqual(sdk.driveCalls, [{ name: driveOf(FORK_ID), region: 'fra1', maxSize: 50 * GIB }]);
  assert.equal(forked[0].region, 'fra1');
  assert.equal(forked[0].mounts[VERCEL_DRIVE_ROOT].drive, driveOf(FORK_ID));
  assert.equal(current()!.session.commands[0].env.SANDBOX_DRIVE_ROOT, VERCEL_DRIVE_ROOT);
});

test('the bootstrap copies the old home into an unmarked drive before marking it, and never deletes the old copy', () => {
  const script = SANDBOX_BOOTSTRAP_SCRIPT;
  const markerCheck = script.indexOf(`[ ! -f "$drive_marker" ]`);
  const copy = script.indexOf('rsync -aH "$persist_root/" "$drive_root/"');
  const fallbackCopy = script.indexOf('cp -a "$persist_root/." "$drive_root/"');
  const mark = script.indexOf(`printf 'migrated %s\\n' "$persist_root" > "$drive_marker.tmp"`);
  assert.ok(
    markerCheck > 0 && copy > markerCheck && fallbackCopy > markerCheck,
    'copy is gated on the marker'
  );
  assert.ok(mark > copy && mark > fallbackCopy, 'the marker is written after the copy');
  assert.match(script, /if \[ "\$copied" -eq 0 \]; then/);
  assert.match(
    script,
    new RegExp(`drive_marker="\\$drive_root/${SANDBOX_DRIVE_MARKER.replace('.', '\\.')}"`)
  );
  const block = script.slice(
    script.indexOf('persist_root="${SANDBOX_PERSIST_ROOT:-}"'),
    script.indexOf('mkdir -p /persist/home /persist/hostkeys')
  );
  assert.doesNotMatch(block, /\brm\b/);
});

function runDriveBlock(env: Record<string, string>, mounted: string | null): string {
  const start = SANDBOX_BOOTSTRAP_SCRIPT.indexOf('persist_root="${SANDBOX_PERSIST_ROOT:-}"');
  const end = SANDBOX_BOOTSTRAP_SCRIPT.indexOf(
    'if [ -n "$persist_root" ] && [ "$persist_root" != "/persist" ]'
  );
  const block = SANDBOX_BOOTSTRAP_SCRIPT.slice(start, end);
  const script = [
    'set -uo pipefail',
    'log() { :; }',
    'have() { command -v "$1" >/dev/null 2>&1; }',
    `mountpoint() { [ -n "\${FAKE_MOUNT:-}" ] && [ "$2" = "$FAKE_MOUNT" ]; }`,
    block,
    'printf "%s" "$persist_root"'
  ].join('\n');
  return execFileSync('bash', ['-c', script], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...env,
      ...(mounted ? { FAKE_MOUNT: mounted } : {})
    }
  }).toString();
}

test('the drive migration runs once, keeps modes, and leaves the old home in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-drive-'));
  const old = join(dir, 'old');
  const drive = join(dir, 'drive');
  mkdirSync(join(old, 'home', '.ssh'), { recursive: true });
  mkdirSync(join(drive, 'lost+found'), { recursive: true });
  writeFileSync(join(old, 'home', '.ssh', 'id'), 'secret');
  chmodSync(join(old, 'home', '.ssh', 'id'), 0o600);
  writeFileSync(join(old, '.setup-done'), '');
  const env = { SANDBOX_PERSIST_ROOT: old, SANDBOX_DRIVE_ROOT: drive };

  assert.equal(runDriveBlock(env, null), old, 'no mounted drive keeps the old home');
  assert.ok(!existsSync(join(drive, SANDBOX_DRIVE_MARKER)));

  assert.equal(runDriveBlock(env, drive), drive);
  assert.equal(readFileSync(join(drive, 'home', '.ssh', 'id'), 'utf8'), 'secret');
  assert.equal(statSync(join(drive, 'home', '.ssh', 'id')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(drive, '.setup-done')));
  assert.match(readFileSync(join(drive, SANDBOX_DRIVE_MARKER), 'utf8'), /^migrated /);
  assert.equal(readFileSync(join(old, 'home', '.ssh', 'id'), 'utf8'), 'secret', 'old copy kept');

  writeFileSync(join(old, 'home', 'later'), 'stale');
  assert.equal(runDriveBlock(env, drive), drive);
  assert.ok(!existsSync(join(drive, 'home', 'later')), 'a marked drive is never copied over again');

  const fresh = join(dir, 'fresh');
  mkdirSync(fresh);
  assert.equal(
    runDriveBlock({ SANDBOX_PERSIST_ROOT: join(dir, 'missing'), SANDBOX_DRIVE_ROOT: fresh }, fresh),
    fresh
  );
  assert.equal(readFileSync(join(fresh, SANDBOX_DRIVE_MARKER), 'utf8'), 'fresh\n');
  assert.equal(
    runDriveBlock({ SANDBOX_PERSIST_ROOT: old }, null),
    old,
    'kubernetes and drive-less boots are unchanged'
  );
});
