import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import {
  GITHUB_NOT_LINKED,
  SandboxGitActorService,
  gitAuthConfig,
  gitAuthFlags,
  gitConfigEnv,
  gitExecPrelude,
  gitIdentity,
  githubLinked,
  githubNoreplyEmail,
  terminalEnvFile,
  terminalEnvPath,
  terminalTmuxEnvScript,
  writeTerminalEnvScript
} from '../src/sandboxes/sandbox-git-identity';
import { SandboxWorkspaceService } from '../src/sandboxes/sandbox-workspace.service';
import { SandboxSessionsController } from '../src/sandboxes/sandbox-sessions.controller';
import {
  sandboxTerminalCommand,
  terminalTmuxName
} from '../src/sandboxes/sandbox-session-commands';
import {
  parseSandboxTerminalQuery,
  sandboxTerminalOwner
} from '../src/sandboxes/sandbox-terminal.gateway';
import { targetKey } from '../src/kubernetes/exec-sessions';
import {
  GIT_IDENTITY_INIT_FILE,
  gitIdentityFile,
  stagedInitFiles
} from '../src/sandboxes/runners/sandbox-init-files';
import { SANDBOX_BOOTSTRAP_SCRIPT } from '../src/sandboxes/sandbox-bootstrap';

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const LURKER = '33333333-3333-4333-8333-333333333333';
const SANDBOX = '44444444-4444-4444-8444-444444444444';
const SID = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
const ENGINE = '55555555-5555-4555-8555-555555555555';
const GUEST_TOKEN = 'ghu_guestSecretToken123';
const HOST_TOKEN = 'ghu_hostSecretToken456';

const USERS: Record<string, any> = {
  [HOST]: {
    id: HOST,
    username: 'hosty',
    email: 'host@example.com',
    firstName: 'Hana',
    lastName: 'Host',
    githubId: '1001',
    githubUsername: 'hana',
    githubAccessToken: HOST_TOKEN,
    githubTokenExpiresAt: null,
    githubRefreshToken: null,
    githubRefreshTokenExpiresAt: null
  },
  [GUEST]: {
    id: GUEST,
    username: 'gus',
    email: 'gus@example.com',
    firstName: null,
    lastName: null,
    githubId: '2002',
    githubUsername: 'gus-gh',
    githubAccessToken: GUEST_TOKEN,
    githubTokenExpiresAt: null,
    githubRefreshToken: null,
    githubRefreshTokenExpiresAt: null
  },
  [LURKER]: {
    id: LURKER,
    username: 'lurker',
    email: 'lurker@example.com',
    firstName: 'Lu',
    lastName: null,
    githubId: null,
    githubUsername: null,
    githubAccessToken: null,
    githubTokenExpiresAt: null,
    githubRefreshToken: null,
    githubRefreshTokenExpiresAt: null
  }
};

function actorService() {
  const prisma = {
    user: { findUnique: async ({ where }: any) => USERS[where.id] ?? null }
  };
  const crypto = { open: (v: string | null) => v };
  return new SandboxGitActorService(prisma as never, crypto as never);
}

function workspace() {
  const calls: Array<{ cmd: string[]; opts: any }> = [];
  const registry = {
    for: () => ({
      exec: async (_ref: unknown, cmd: string[], opts: any = {}) => {
        calls.push({ cmd, opts });
        return { stdout: 'done', stderr: '', exitCode: 0, ok: true };
      }
    })
  };
  const svc = new SandboxWorkspaceService(
    registry as never,
    {} as never,
    {} as never,
    actorService()
  );
  return { svc, calls };
}

const BOX = {
  id: SANDBOX,
  userId: HOST,
  runner: 'kubernetes' as const,
  podName: 'sbx-x',
  namespace: 'orchard-sandboxes',
  externalId: null,
  runnerState: null,
  status: 'running',
  repoUrl: null
};

test('git identity uses the GitHub noreply address when GitHub is linked, else the Orchard one', () => {
  assert.deepEqual(gitIdentity(USERS[HOST]), {
    name: 'Hana Host',
    email: '1001+hana@users.noreply.github.com'
  });
  assert.deepEqual(gitIdentity(USERS[GUEST]), {
    name: 'gus-gh',
    email: '2002+gus-gh@users.noreply.github.com'
  });
  assert.deepEqual(gitIdentity(USERS[LURKER]), { name: 'Lu', email: 'lurker@example.com' });
  assert.equal(githubNoreplyEmail('12', 'bad login'), null);
  assert.equal(githubNoreplyEmail('x1', 'ok'), null);
  const evil = gitIdentity({
    id: 'x',
    username: 'u',
    email: 'not an email',
    firstName: 'Eve\n<root@x>',
    lastName: null
  });
  assert.equal(evil.name, 'Eve root@x');
  assert.equal(evil.email, 'sandbox@orchard.dev');
});

test('github is linked only while a token or a live refresh token exists', () => {
  const now = Date.now();
  const base = USERS[GUEST];
  assert.equal(githubLinked(base, now), true);
  assert.equal(githubLinked({ ...base, githubAccessToken: null }, now), false);
  const expired = { ...base, githubTokenExpiresAt: new Date(now - 1000) };
  assert.equal(githubLinked(expired, now), false);
  assert.equal(githubLinked({ ...expired, githubRefreshToken: 'r' }, now), true);
  assert.equal(
    githubLinked(
      { ...expired, githubRefreshToken: 'r', githubRefreshTokenExpiresAt: new Date(now - 1) },
      now
    ),
    false
  );
});

test('a guest push runs with the guest identity and token, the token only on stdin', async () => {
  const { svc, calls } = workspace();
  const result = await svc.gitPush(BOX, { repo: 'app' }, GUEST, { force: true });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { cmd, opts } = calls[0];
  const argv = cmd.join('\u0000');
  assert.ok(!argv.includes(GUEST_TOKEN), 'the token never rides argv');
  assert.ok(!argv.includes(HOST_TOKEN));
  assert.equal(opts.env, undefined, 'no env option, it would become argv on kubernetes');
  assert.equal(Buffer.from(opts.stdin).toString(), `${GUEST_TOKEN}\n`);
  const script = cmd[cmd.length - 1];
  assert.match(script, /GIT_AUTHOR_EMAIL='2002\+gus-gh@users\.noreply\.github\.com'/);
  assert.match(script, /GIT_COMMITTER_NAME='gus-gh'/);
  assert.match(script, /IFS= read -r ORCHARD_GIT_TOKEN/);
  assert.match(script, /push --force-with-lease origin HEAD/);
  const reset = script.indexOf("-c 'credential.helper='");
  const helper = script.indexOf("-c 'credential.helper=!f()");
  assert.ok(reset > 0 && helper > reset, 'the inherited helper is cleared before ours is added');
  assert.match(script, /"password=\$ORCHARD_GIT_TOKEN"/);
  assert.match(script, /-c 'http\.extraHeader='/);
});

test('fetch, pull and remote branch delete authenticate as the actor; local ops do not read a token', async () => {
  const { svc, calls } = workspace();
  await svc.gitFetch(BOX, { repo: 'app' }, GUEST);
  await svc.gitPull(BOX, { repo: 'app' }, GUEST, { rebase: true });
  await svc.gitDeleteBranch(BOX, { repo: 'app' }, 'feature', GUEST, { remote: true });
  await svc.gitDeleteBranch(BOX, { repo: 'app' }, 'feature', GUEST, { remote: false });
  await svc.gitCommit(BOX, { repo: 'app' }, 'msg', undefined, LURKER);
  await svc.gitUncommit(BOX, { repo: 'app' }, LURKER);
  const tokenOps = calls.slice(0, 3);
  for (const c of tokenOps) {
    assert.equal(Buffer.from(c.opts.stdin).toString(), `${GUEST_TOKEN}\n`);
    assert.ok(!c.cmd.join(' ').includes(GUEST_TOKEN));
  }
  assert.match(tokenOps[2].cmd.at(-1)!, /push origin --delete 'feature'/);
  for (const c of calls.slice(3)) assert.equal(c.opts.stdin, undefined);
  assert.match(calls[4].cmd.at(-1)!, /GIT_AUTHOR_NAME='Lu' GIT_AUTHOR_EMAIL='lurker@example\.com'/);
  assert.match(calls[4].cmd.at(-1)!, /git commit -m 'msg'/);
  assert.doesNotMatch(calls[4].cmd.at(-1)!, /user\.name/);
  assert.match(calls[5].cmd.at(-1)!, /GIT_COMMITTER_EMAIL='lurker@example\.com'/);
});

test('without a linked GitHub account push, fetch, pull and PR return 409 github_not_linked', async () => {
  const { svc, calls } = workspace();
  const attempts = [
    () => svc.gitPush(BOX, { repo: 'app' }, LURKER),
    () => svc.gitFetch(BOX, { repo: 'app' }, LURKER),
    () => svc.gitPull(BOX, { repo: 'app' }, LURKER),
    () => svc.gitDeleteBranch(BOX, { repo: 'app' }, 'x', LURKER, { remote: true }),
    () => svc.createPullRequest(BOX, { repo: 'app' }, LURKER, { title: 'PR' })
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e: any) => {
      assert.ok(e instanceof ConflictException);
      assert.equal(e.getStatus(), 409);
      assert.deepEqual(e.getResponse(), { ...GITHUB_NOT_LINKED });
      return true;
    });
  }
  assert.equal(calls.length, 0, 'nothing ran in the box');
  const commit = await svc.gitCommit(BOX, { repo: 'app' }, 'local only', undefined, LURKER);
  assert.equal(commit.ok, true, 'a guest without GitHub can still commit locally');
});

test('merge refuses a guest with no GitHub link before touching GitHub', async () => {
  let merged = false;
  const access = {
    async requireSandboxRole() {
      return { sandbox: BOX, role: 'collaborator' };
    }
  };
  const users = {
    async findOrCreateByClerkId() {
      return { id: LURKER, email: null };
    }
  };
  const sessions = {
    async merge() {
      merged = true;
    }
  };
  const c = new SandboxSessionsController(
    access as never,
    sessions as never,
    {} as never,
    users as never,
    { configured: false } as never,
    actorService()
  );
  await assert.rejects(
    c.merge({ user: { sub: 'x' } }, SANDBOX, SID, {}),
    (e: any) => e.getStatus() === 409 && e.getResponse().code === 'github_not_linked'
  );
  assert.equal(merged, false);
});

test('the real git binary takes the actor token from the helper and never the inherited one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-git-'));
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(
    globalConfig,
    `[credential]\n\thelper = "!f(){ echo username=host; echo password=${HOST_TOKEN}; }; f"\n`
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1'
  };
  const identity = gitIdentity(USERS[GUEST]);
  const script = `${gitExecPrelude(identity, true)}\ngit ${gitAuthFlags()} credential fill; echo "author=$GIT_AUTHOR_EMAIL"`;
  const out = execFileSync('/bin/sh', ['-c', script], {
    env,
    input: `${GUEST_TOKEN}\nprotocol=https\nhost=github.com\n\n`
  }).toString();
  assert.match(out, new RegExp(`password=${GUEST_TOKEN}`));
  assert.match(out, /username=x-access-token/);
  assert.ok(!out.includes(`password=${HOST_TOKEN}`), 'the box helper was reset');
  assert.match(out, /author=2002\+gus-gh@users\.noreply\.github\.com/);
  const viaEnv = spawnSync('git', ['credential', 'fill'], {
    env: { ...env, ...gitConfigEnv(gitAuthConfig(true)), ORCHARD_GIT_TOKEN: GUEST_TOKEN },
    input: 'protocol=https\nhost=github.com\n\n'
  }).stdout.toString();
  assert.match(viaEnv, new RegExp(`password=${GUEST_TOKEN}`));
  const noToken = spawnSync('git', ['credential', 'fill'], {
    env: { ...env, ...gitConfigEnv(gitAuthConfig(false)), GIT_TERMINAL_PROMPT: '0' },
    input: 'protocol=https\nhost=github.com\n\n'
  });
  assert.ok(!noToken.stdout.toString().includes(HOST_TOKEN), 'no host fallback without a token');
});

test('guest terminals get their own tmux session and their own git env; host terminals are unchanged', () => {
  const base = { sessionId: SID, worktreePath: '/persist/home/.worktrees/app/fix', index: '0' };
  const host = sandboxTerminalCommand({ ...base, mode: 'rw' }, ENGINE).join(' ');
  assert.match(host, /new-session -A -s '\\''orchard-3f2d7e6a-0'\\''/);
  assert.doesNotMatch(host, /orchard-term/);

  const guestName = terminalTmuxName({ ...base, mode: 'rw', terminalUserId: GUEST }, ENGINE);
  assert.equal(guestName, `orchard-3f2d7e6a-0-u${GUEST.replace(/-/g, '')}`);
  assert.notEqual(guestName, terminalTmuxName({ ...base, mode: 'rw' }, ENGINE));
  assert.equal(
    terminalTmuxName({ ...base, index: 'setup', mode: 'ro', terminalUserId: GUEST }, ENGINE),
    'orchard-3f2d7e6a-setup',
    'setup and run stay shared'
  );
  assert.throws(() => terminalTmuxName({ ...base, mode: 'rw', terminalUserId: 'nope' }, ENGINE));

  const actor = {
    userId: GUEST,
    identity: gitIdentity(USERS[GUEST]),
    githubLogin: 'gus-gh',
    token: GUEST_TOKEN
  };
  const envFile = terminalEnvPath(ENGINE);
  const guest = sandboxTerminalCommand({ ...base, mode: 'rw', terminalUserId: GUEST }, ENGINE, {
    envFile,
    tmuxEnv: terminalTmuxEnvScript(actor.identity, true)
  }).join(' ');
  assert.ok(guest.includes(guestName));
  assert.ok(guest.includes(envFile));
  assert.match(guest, /rm -f/);
  assert.ok(!guest.includes(GUEST_TOKEN), 'the terminal command never carries the token');
  assert.ok(!terminalTmuxEnvScript(actor.identity, true).includes('ORCHARD_GIT_TOKEN '));

  const watch = sandboxTerminalCommand({ ...base, mode: 'ro', terminalUserId: GUEST }, ENGINE).join(
    ' '
  );
  assert.ok(watch.includes(`attach-session -r -t '\\''=${guestName}'\\''`));
  assert.doesNotMatch(watch, /new-session/);

  const file = terminalEnvFile(actor);
  assert.match(file, new RegExp(`ORCHARD_GIT_TOKEN='${GUEST_TOKEN}'`));
  assert.match(file, /GIT_CONFIG_KEY_0='credential\.helper' GIT_CONFIG_VALUE_0=''/);
  assert.match(file, /GIT_AUTHOR_EMAIL='2002\+gus-gh@users\.noreply\.github\.com'/);
  assert.ok(!writeTerminalEnvScript(envFile).includes(GUEST_TOKEN));
  assert.match(writeTerminalEnvScript(envFile), /umask 077/);
  assert.throws(() => terminalEnvPath('../../etc/passwd'));
  const noToken = terminalEnvFile({ ...actor, token: null });
  assert.doesNotMatch(noToken, /ORCHARD_GIT_TOKEN=/);
  assert.match(noToken, /GIT_CONFIG_COUNT='2'/);
});

test('terminal owner: rw is always your own shell, watching someone else is read-only', () => {
  const q = (s: string) => parseSandboxTerminalQuery(new URLSearchParams(s))!;
  const own = (query: string, principal: string, grantedMode: 'rw' | 'ro') =>
    sandboxTerminalOwner({ query: q(query), grantedMode, principal, hostUserId: HOST });
  assert.deepEqual(own(`sid=${SID}&n=0`, HOST, 'rw'), { mode: 'rw', terminalUserId: null });
  assert.deepEqual(own(`sid=${SID}&n=0`, GUEST, 'rw'), { mode: 'rw', terminalUserId: GUEST });
  assert.deepEqual(own(`sid=${SID}&n=0&user=${HOST}`, GUEST, 'rw'), {
    mode: 'ro',
    terminalUserId: null
  });
  assert.deepEqual(own(`sid=${SID}&n=0&mode=ro`, LURKER, 'ro'), {
    mode: 'ro',
    terminalUserId: null
  });
  assert.deepEqual(own(`sid=${SID}&n=1&user=${GUEST}`, HOST, 'rw'), {
    mode: 'ro',
    terminalUserId: GUEST
  });
  assert.deepEqual(own(`sid=${SID}&n=setup`, GUEST, 'ro'), { mode: 'ro', terminalUserId: null });
  assert.deepEqual(own('', GUEST, 'rw'), { mode: 'rw', terminalUserId: GUEST });
  assert.equal(parseSandboxTerminalQuery(new URLSearchParams(`user=${GUEST}`)), null);
  assert.equal(parseSandboxTerminalQuery(new URLSearchParams(`sid=${SID}&user=nope`)), null);
  const box = {
    kind: 'sandbox' as const,
    sandboxId: SANDBOX,
    sessionId: SID,
    index: '0',
    mode: 'rw' as const,
    worktreePath: null
  };
  assert.notEqual(targetKey(box), targetKey({ ...box, terminalUserId: GUEST }));
  assert.equal(targetKey({ ...box, terminalUserId: null }), targetKey(box));
});

test('the host git identity reaches the box as an init file the bootstrap applies once', () => {
  assert.equal(gitIdentityFile(null), '');
  assert.equal(gitIdentityFile({ name: 'Hana\nHost', email: 'h@x.dev' }), 'Hana Host\nh@x.dev\n');
  const files = stagedInitFiles({
    authorizedKeys: [],
    githubToken: null,
    claudeToken: null,
    openaiToken: null,
    setupScript: null,
    mcpToken: null,
    opencodePassword: null,
    bridgeToken: null,
    gitIdentity: gitIdentity(USERS[HOST])
  });
  assert.equal(files[GIT_IDENTITY_INIT_FILE], 'Hana Host\n1001+hana@users.noreply.github.com\n');
  assert.match(SANDBOX_BOOTSTRAP_SCRIPT, /\/orchard-init\/git-identity/);
  assert.match(
    SANDBOX_BOOTSTRAP_SCRIPT,
    /git config --file \/persist\/home\/\.gitconfig user\.email/
  );
});
