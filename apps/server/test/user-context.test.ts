import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENCODE_USER_CONFIG,
  boxFilesFor,
  opencodeUserConfig,
  toOpencodeAgent,
  toOpencodeCommand,
  toOpencodeMcp,
  validateContextItem
} from '../src/sandboxes/context/user-context';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { UserContextService } from '../src/sandboxes/context/user-context.service';

test('context items validate their kind, name, files and mcp shape', () => {
  assert.equal(
    validateContextItem({ kind: 'instructions', name: 'CLAUDE.md', files: { 'CLAUDE.md': '# hi' } })
      .name,
    'CLAUDE.md'
  );
  assert.throws(() => validateContextItem({ kind: 'nope', name: 'x' }), /kind must be/);
  assert.throws(
    () => validateContextItem({ kind: 'instructions', name: 'notes', files: { 'notes.md': '' } }),
    /named CLAUDE.md/
  );
  assert.throws(
    () => validateContextItem({ kind: 'agent', name: 'review', files: { 'other.md': 'x' } }),
    /must be named review.md/
  );
  assert.throws(
    () => validateContextItem({ kind: 'skill', name: 'pdf', files: { 'README.md': 'x' } }),
    /needs a SKILL.md/
  );
  assert.throws(
    () => validateContextItem({ kind: 'mcp', name: 'orchard', mcp: { url: 'https://x' } }),
    /reserved/
  );
  assert.throws(
    () => validateContextItem({ kind: 'mcp', name: 'gh', mcp: { args: [] } }),
    /command or a url/
  );
  assert.throws(
    () => validateContextItem({ kind: 'mcp', name: 'gh', mcp: { url: 'file:///etc' } }),
    /http/
  );
  assert.throws(
    () =>
      validateContextItem({
        kind: 'agent',
        name: 'a',
        files: { 'a.md': 'x'.repeat(256 * 1024 + 1) }
      }),
    /larger than/
  );
});

test('names and skill paths cannot escape the managed folders', () => {
  for (const name of ['../x', 'a/b', '.hidden', 'a:..:b', 'a::b', '']) {
    assert.throws(() =>
      validateContextItem({ kind: 'command', name, files: { [`${name}.md`]: 'x' } })
    );
  }
  for (const path of ['../SKILL.md', '/etc/passwd', 'a/../../b', 'a\\b', '.git/config']) {
    assert.throws(() =>
      validateContextItem({ kind: 'skill', name: 'pdf', files: { 'SKILL.md': 'x', [path]: 'y' } })
    );
  }
  const ok = validateContextItem({
    kind: 'skill',
    name: 'pdf',
    files: { 'SKILL.md': 'x', 'scripts/fill form.py': 'y' }
  });
  assert.deepEqual(Object.keys(ok.payload.files ?? {}), ['SKILL.md', 'scripts/fill form.py']);
});

test('claude agents and commands convert to opencode keeping only the description', () => {
  const agent =
    '---\nname: reviewer\ndescription: Reviews code\n  carefully\ntools: Read, Grep\nmodel: sonnet\n---\nYou review.\n';
  assert.equal(
    toOpencodeAgent('reviewer', agent),
    '---\ndescription: Reviews code\n  carefully\nmode: subagent\n---\nYou review.\n'
  );
  assert.equal(
    toOpencodeAgent('plain', 'Just a body\n'),
    '---\ndescription: "plain"\nmode: subagent\n---\nJust a body\n'
  );
  const command =
    '---\ndescription: Ship it\nargument-hint: [msg]\nallowed-tools: Bash(git:*)\n---\nCommit $ARGUMENTS\n';
  assert.equal(toOpencodeCommand(command), '---\ndescription: Ship it\n---\nCommit $ARGUMENTS\n');
  assert.equal(toOpencodeCommand('No frontmatter'), 'No frontmatter');
});

test('mcp servers map to local or remote opencode entries', () => {
  assert.deepEqual(toOpencodeMcp({ command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 't' } }), {
    type: 'local',
    command: ['npx', '-y', 'gh-mcp'],
    environment: { TOKEN: 't' },
    enabled: true
  });
  assert.deepEqual(
    toOpencodeMcp({ type: 'http', url: 'https://mcp.example.com', headers: { A: 'b' } }),
    {
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { A: 'b' },
      enabled: true
    }
  );
});

test('box files land in the claude and opencode folders the agents read', () => {
  const items = [
    validateContextItem({
      kind: 'instructions',
      name: 'CLAUDE.md',
      files: { 'CLAUDE.md': 'rules' }
    }),
    validateContextItem({ kind: 'agent', name: 'reviewer', files: { 'reviewer.md': 'body' } }),
    validateContextItem({ kind: 'command', name: 'git:ship', files: { 'git:ship.md': 'ship' } }),
    validateContextItem({
      kind: 'skill',
      name: 'pdf',
      files: { 'SKILL.md': 's', 'lib/a.py': 'a' }
    }),
    validateContextItem({ kind: 'mcp', name: 'gh', mcp: { command: 'gh-mcp' } })
  ];
  const { files, mcp } = boxFilesFor(items);
  assert.deepEqual(Object.keys(files).sort(), [
    '/persist/home/.claude/CLAUDE.md',
    '/persist/home/.claude/agents/reviewer.md',
    '/persist/home/.claude/commands/git/ship.md',
    '/persist/home/.claude/skills/pdf/SKILL.md',
    '/persist/home/.claude/skills/pdf/lib/a.py',
    '/persist/home/.config/opencode/agent/reviewer.md',
    '/persist/home/.config/opencode/command/git:ship.md'
  ]);
  assert.deepEqual(Object.keys(mcp), ['gh']);
  assert.equal(OPENCODE_USER_CONFIG, '/persist/home/.config/opencode/opencode.jsonc');
  assert.deepEqual(JSON.parse(opencodeUserConfig({})), {});
  assert.deepEqual(Object.keys(JSON.parse(opencodeUserConfig(mcp)).mcp), ['gh']);
});

test('user context is encrypted per user and cannot be opened with another user id', () => {
  process.env.SECRETS_ENCRYPTION_KEY = 'test-key-test-key-test-key';
  const crypto = new SecretCryptoService();
  const sealed = crypto.encryptForUser('user-a', 'my CLAUDE.md');
  assert.ok(sealed.startsWith('enc:u1:'));
  assert.ok(!sealed.includes('CLAUDE'));
  assert.equal(crypto.decryptForUser('user-a', sealed), 'my CLAUDE.md');
  assert.throws(() => crypto.decryptForUser('user-b', sealed));
  assert.notEqual(crypto.encryptForUser('user-a', 'same'), crypto.encryptForUser('user-a', 'same'));
});

function syncHarness(opts: { busy?: boolean } = {}) {
  process.env.SECRETS_ENCRYPTION_KEY = 'test-key-test-key-test-key';
  const crypto = new SecretCryptoService();
  const userId = 'u1';
  const rows: Array<{
    kind: string;
    name: string;
    payload: string;
    enabled: boolean;
    lock: string;
    userId: string;
  }> = [];
  const put = (kind: string, name: string, payload: object) =>
    rows.push({
      kind,
      name,
      payload: crypto.encryptForUser(userId, JSON.stringify(payload)),
      enabled: true,
      lock: 'server',
      userId
    });
  const disk = new Map<string, string>();
  const execs: string[] = [];
  const calls: string[] = [];
  const runner = {
    exec: async (_ref: unknown, command: string[]) => {
      const script = command[command.length - 1];
      execs.push(script);
      if (script.startsWith('cat ')) {
        const manifest = disk.get('/persist/home/.orchard/context-manifest.json');
        return { ok: !!manifest, exitCode: manifest ? 0 : 1, stdout: manifest ?? '', stderr: '' };
      }
      for (const path of script.match(/'[^']+'/g) ?? []) disk.delete(path.slice(1, -1));
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
    writeFiles: async (
      _ref: unknown,
      files: Array<{ path: string; content: Buffer }>,
      o: { asUser?: string }
    ) => {
      assert.equal(o.asUser, 'dev');
      for (const file of files) disk.set(file.path, file.content.toString('utf8'));
    }
  };
  const prisma = {
    userContextItem: { findMany: async () => rows.filter((r) => r.enabled) },
    sandboxConversation: {
      findMany: async () => [{ worktreePath: '/persist/home/.worktrees/app/fix' }]
    }
  };
  const workspace = {
    opencodeRequest: async (_s: unknown, method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path === '/session/status')
        return { status: 200, body: opts.busy ? { ses_1: { type: 'busy' } } : {} };
      return { status: 200, body: true };
    }
  };
  const service = new UserContextService(
    prisma as any,
    crypto,
    { for: () => runner } as any,
    workspace as any
  );
  const sandbox = {
    id: 'sbx',
    userId,
    status: 'running',
    runner: 'vercel',
    podName: 'sbx-1',
    namespace: null,
    externalId: null,
    runnerState: null,
    repoUrl: null
  };
  return { service, sandbox, put, rows, disk, execs, calls };
}

test('syncing writes managed files as dev, skips unchanged content and removes only stale managed files', async () => {
  const h = syncHarness();
  h.put('instructions', 'CLAUDE.md', { files: { 'CLAUDE.md': 'rules' } });
  h.put('agent', 'reviewer', { files: { 'reviewer.md': 'body' } });
  h.disk.set('/persist/home/.claude/agents/mine.md', 'written by the user in the box');
  const first = await h.service.syncToSandbox(h.sandbox as any);
  assert.equal(first.changed, true);
  assert.equal(first.reloaded, true);
  assert.equal(h.disk.get('/persist/home/.claude/CLAUDE.md'), 'rules');
  assert.ok(h.disk.has('/persist/home/.config/opencode/agent/reviewer.md'));
  assert.equal(h.disk.get('/persist/home/.config/opencode/opencode.jsonc'), '{}\n');
  assert.ok(h.calls.includes('POST /global/dispose'));

  const again = await h.service.syncToSandbox(h.sandbox as any);
  assert.equal(again.changed, false);

  h.rows.splice(1, 1);
  await h.service.syncToSandbox(h.sandbox as any);
  assert.ok(!h.disk.has('/persist/home/.claude/agents/reviewer.md'));
  assert.ok(!h.disk.has('/persist/home/.config/opencode/agent/reviewer.md'));
  assert.equal(
    h.disk.get('/persist/home/.claude/agents/mine.md'),
    'written by the user in the box'
  );
});

test('a manifest pointing outside the managed folders never deletes those paths', async () => {
  const h = syncHarness();
  h.put('instructions', 'CLAUDE.md', { files: { 'CLAUDE.md': 'rules' } });
  h.disk.set(
    '/persist/home/.orchard/context-manifest.json',
    JSON.stringify({
      hash: 'old',
      paths: ['/persist/home/.ssh/authorized_keys', '/persist/home/.claude/agents/../../.bashrc']
    })
  );
  await h.service.syncToSandbox(h.sandbox as any);
  assert.ok(
    !h.execs.some((script) => script.includes('authorized_keys') || script.includes('.bashrc'))
  );
});

test('the agent is not reloaded while a turn is running', async () => {
  const h = syncHarness({ busy: true });
  h.put('mcp', 'gh', { mcp: { command: 'gh-mcp' } });
  const result = await h.service.syncToSandbox(h.sandbox as any);
  assert.equal(result.changed, true);
  assert.equal(result.reloaded, false);
  assert.ok(!h.calls.includes('POST /global/dispose'));
  assert.deepEqual(
    Object.keys(
      JSON.parse(h.disk.get('/persist/home/.config/opencode/opencode.jsonc') ?? '{}').mcp
    ),
    ['gh']
  );
});
