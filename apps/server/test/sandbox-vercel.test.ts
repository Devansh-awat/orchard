import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERCEL_BRIDGE_PORT,
  VERCEL_INIT_STAGE,
  VERCEL_OPENCODE_PORT,
  VERCEL_OP_DESTROY,
  VERCEL_OP_PROVISION,
  VERCEL_OP_SECRET,
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
import { SANDBOX_BOOTSTRAP_SCRIPT } from '../src/sandboxes/sandbox-bootstrap';
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
    this.deletes += 1;
  }

  async update(params: any) {
    this.updates.push(params);
  }
}

function vercelRunner(
  row: Record<string, unknown> | null,
  opts: { existing?: FakeSandbox | null; getError?: Error; values?: Record<string, string> } = {}
) {
  const enqueued: any[] = [];
  const updates: any[] = [];
  const deleted: any[] = [];
  const created: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  const values: Record<string, string> = {
    vercelToken: 'vercel-api-token',
    vercelTeamId: 'team_1',
    vercelProjectId: 'prj_1',
    ...(opts.values ?? {})
  };
  const prisma = {
    sandbox: {
      findUnique: async () => row,
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
    { forSandbox: async () => SECRETS } as never
  );
  runner.sdk = {
    get: async () => {
      if (opts.getError) throw opts.getError;
      if (!existing) throw notFound();
      return existing as never;
    },
    create: async (params: any) => {
      created.push(params);
      existing = new FakeSandbox(params.name);
      return existing as never;
    }
  };
  runner.bootPollMs = 1;
  return {
    runner,
    enqueued,
    updates,
    deleted,
    created,
    handlers,
    current: () => existing
  };
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
      key: { regex: '(?i)^authorization$' },
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

  const settled = updates.find((u) => u.data?.status === 'running');
  assert.ok(settled, 'row marked running');
  assert.equal(settled.data.externalId, REF.podName);
});

test('an existing box is resumed and gets the current network policy instead of a new create', async () => {
  const box = new FakeSandbox(REF.podName, 'running');
  const { handlers, created } = vercelRunner(ROW, { existing: box });
  await handlers.get(VERCEL_OP_PROVISION)!({ manifest: { sandboxId: REF.id } });
  assert.equal(created.length, 0);
  assert.equal(box.updates.length, 1);
  assert.equal(
    box.updates[0].networkPolicy.allow['api.github.com'][0].transform[0].headers.authorization,
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
