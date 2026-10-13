import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { SANDBOX_PHASE_FILE } from '../server/src/sandboxes/sandbox-bootstrap';
import { TMUX_TERMINAL } from '../server/src/sandboxes/sandbox-session-commands';
import { renderEnvFile } from '../server/src/sandboxes/links/sandbox-env-files';
import { KubernetesSandboxRunner } from '../server/src/sandboxes/runners/kubernetes.runner';
import {
  VERCEL_INIT_STAGE,
  VERCEL_PERSIST_ROOT,
  VercelSandboxRunner,
  type VercelCommandLike,
  type VercelRunCommandParams,
  type VercelSessionLike
} from '../server/src/sandboxes/runners/vercel.runner';
import type { SandboxRunner, SandboxSecrets } from '../server/src/sandboxes/runners/sandbox-runner';
import { SandboxWorkspaceService } from '../server/src/sandboxes/sandbox-workspace.service';
import { SandboxSessionsService } from '../server/src/sandboxes/sandbox-sessions.service';
import {
  HOME_ROOT,
  WORKTREES_ROOT,
  buildPortsScript,
  buildScriptStop,
  buildWorktreeAddScript,
  buildWorktreeRemoveScript,
  buildWorktreeRestoreScript,
  parsePortsOutput,
  parseWorktreeAddOutput,
  sessionBranch,
  sessionStateDir,
  shellQuote,
  tmuxSessionName,
  worktreePathFor
} from '../server/src/sandboxes/sandbox-session-commands';
import {
  terminalEnvFile,
  terminalEnvPath,
  writeTerminalEnvScript,
  type GitActor
} from '../server/src/sandboxes/sandbox-git-identity';

const HELP = `Usage: pnpm --filter server smoke:sandbox-bootstrap [options]

Boots the Greenhouse sandbox bootstrap in throwaway Docker containers the way each
runner does, then drives the real runner exec paths and the session, workspace and
git helpers against the live container.

  k8s     debian:bookworm, bootstrap is PID 1, /orchard-init and the authorized_keys
          directory are read-only mounts rendered from KubernetesSandboxRunner.buildCr
          and secretData, /persist is a Docker volume, SANDBOX_HOME_MODE=filesystem.
          Finishes with a pod restart on the same volume.
  vercel  ubuntu:24.04 with Amazon Linux's /etc/skel shape (no .profile), files staged
          by VercelSandboxRunner.pushInit into ${VERCEL_INIT_STAGE}, SANDBOX_HOME_MODE=none,
          SANDBOX_PERSIST_ROOT=${VERCEL_PERSIST_ROOT}, a file:// bridge tarball with a
          checksum, then reruns pushInit with changed secrets.

Agent CLIs (claude, codex, opencode) are stubbed by default so npm installs are skipped;
the opencode stub records the password it was started with.

Options
  --only k8s|vercel     run one target
  --k8s-image IMAGE     default debian:bookworm
  --vercel-image IMAGE  default ubuntu:24.04
  --repo-url URL        SANDBOX_REPO_URL for the k8s boot (default octocat/Hello-World)
  --no-clone            leave SANDBOX_REPO_URL empty
  --no-restart          skip the k8s pod restart round
  --real-agents         do not stub the agent CLIs (npm installs them, slow)
  --stub-node           stub node and npm so the nodesource install is skipped
  --boot-timeout SEC    seconds to wait for a boot to reach ready (default 900)
  --keep                leave containers and the volume behind for debugging
  -h, --help            show this help

Exit status is 0 when every check passes. Nothing outside Docker is touched; every
container carries the label orchard-smoke and is removed unless --keep is given.
`;

interface Options {
  only: 'k8s' | 'vercel' | null;
  k8sImage: string;
  vercelImage: string;
  repoUrl: string;
  restart: boolean;
  realAgents: boolean;
  stubNode: boolean;
  bootTimeoutMs: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    only: null,
    k8sImage: 'debian:bookworm',
    vercelImage: 'ubuntu:24.04',
    repoUrl: 'https://github.com/octocat/Hello-World.git',
    restart: true,
    realAgents: false,
    stubNode: false,
    bootTimeoutMs: 900_000,
    keep: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === '--only') {
      const v = value();
      if (v !== 'k8s' && v !== 'vercel') throw new Error('--only takes k8s or vercel');
      opts.only = v;
    } else if (arg === '--k8s-image') opts.k8sImage = value();
    else if (arg === '--vercel-image') opts.vercelImage = value();
    else if (arg === '--repo-url') opts.repoUrl = value();
    else if (arg === '--no-clone') opts.repoUrl = '';
    else if (arg === '--no-restart') opts.restart = false;
    else if (arg === '--real-agents') opts.realAgents = true;
    else if (arg === '--stub-node') opts.stubNode = true;
    else if (arg === '--boot-timeout') opts.bootTimeoutMs = Number(value()) * 1000;
    else if (arg === '--keep') opts.keep = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

interface Result {
  suite: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function record(suite: string, name: string, ok: boolean, detail = ''): boolean {
  results.push({ suite, name, ok, detail });
  const line = `  ${ok ? 'ok  ' : 'FAIL'} [${suite}] ${name}${detail && !ok ? `\n         ${detail.replace(/\n/g, '\n         ')}` : detail ? ` (${detail})` : ''}`;
  process.stdout.write(`${line}\n`);
  return ok;
}

async function attempt(
  suite: string,
  name: string,
  fn: () => Promise<string | void> | string | void
) {
  try {
    const detail = await fn();
    record(suite, name, true, detail || '');
  } catch (e: any) {
    record(suite, name, false, String(e?.message ?? e));
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  out: Buffer;
  err: Buffer;
}

function docker(args: string[], opts: { input?: Buffer | string; timeoutMs?: number } = {}): Run {
  const r = spawnSync('docker', args, {
    input: opts.input,
    timeout: opts.timeoutMs ?? 180_000,
    maxBuffer: 256 * 1024 * 1024
  });
  const out = r.stdout ?? Buffer.alloc(0);
  const err = r.stderr ?? Buffer.alloc(0);
  return { code: r.status, stdout: out.toString('utf8'), stderr: err.toString('utf8'), out, err };
}

class Box {
  constructor(
    readonly name: string,
    readonly suite: string
  ) {}

  sh(script: string, opts: { input?: Buffer | string; timeoutMs?: number } = {}): Run {
    return docker(
      ['exec', ...(opts.input !== undefined ? ['-i'] : []), this.name, 'bash', '-c', script],
      opts
    );
  }

  dev(script: string, opts: { input?: Buffer | string; timeoutMs?: number } = {}): Run {
    return docker(
      [
        'exec',
        ...(opts.input !== undefined ? ['-i'] : []),
        this.name,
        'su',
        '-l',
        'dev',
        '-c',
        script
      ],
      opts
    );
  }

  out(script: string): string {
    return this.sh(script).stdout.trim();
  }

  ok(script: string): boolean {
    return this.sh(script).code === 0;
  }

  write(path: string, content: string | Buffer, mode = '644', owner = 'root') {
    const r = this.sh(
      `mkdir -p "$(dirname ${shellQuote(path)})" && cat > ${shellQuote(path)} && chmod ${mode} ${shellQuote(path)} && chown ${owner}:${owner} ${shellQuote(path)}`,
      { input: content }
    );
    if (r.code !== 0) throw new Error(`could not write ${path}: ${r.stderr}`);
  }
}

const created = { containers: new Set<string>(), volumes: new Set<string>() };

function cleanup(keep: boolean) {
  if (keep) {
    if (created.containers.size || created.volumes.size) {
      process.stdout.write(
        `\nkept: containers ${[...created.containers].join(' ') || '-'}; volumes ${[...created.volumes].join(' ') || '-'}\n`
      );
    }
    return;
  }
  for (const name of created.containers) docker(['rm', '-f', '-v', name]);
  for (const name of created.volumes) docker(['volume', 'rm', '-f', name]);
  created.containers.clear();
  created.volumes.clear();
}

function stubFiles(dir: string, opts: Options): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  const put = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    files[name] = path;
  };
  if (!opts.realAgents) {
    put(
      'opencode',
      [
        '#!/bin/bash',
        'if [ "${1:-}" = serve ]; then',
        '  printf "%s\\n" "${OPENCODE_SERVER_PASSWORD:-}" > /tmp/opencode-stub-password',
        '  printf "%s\\n" "$*" > /tmp/opencode-stub-args',
        '  id -un > /tmp/opencode-stub-user',
        '  while :; do sleep 3600; done',
        'fi',
        'echo opencode-stub',
        ''
      ].join('\n')
    );
    put('claude', '#!/bin/sh\necho claude-stub\n');
    put('codex', '#!/bin/sh\necho codex-stub\n');
  }
  if (opts.stubNode) {
    put('node', '#!/bin/sh\necho v22.0.0-stub\n');
    put('npm', '#!/bin/sh\necho npm-stub\n');
  }
  return files;
}

function stubMounts(stubs: Record<string, string>): string[] {
  return Object.entries(stubs).flatMap(([name, path]) => [
    '-v',
    `${path}:/usr/local/bin/${name}:ro`
  ]);
}

function sshKeypair(dir: string): { priv: string; pub: string } {
  const path = join(dir, 'id_ed25519');
  const r = spawnSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'smoke@orchard',
    '-f',
    path
  ]);
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  return { priv: readFileSync(path, 'utf8'), pub: readFileSync(`${path}.pub`, 'utf8').trim() };
}

function envBundle(variant: 'a' | 'b'): Record<string, string> {
  const web = renderEnvFile({
    projectName: 'web',
    environmentName: 'production',
    vars: [
      { key: 'SMOKE_GREETING', value: variant === 'a' ? "it's alive" : 'second wind' },
      { key: 'SMOKE_SPACES', value: 'a b  $HOME `id` "q"' },
      { key: 'PATH', value: '/evil' },
      { key: 'SMOKE_SECRET', value: 'hidden', secret: true }
    ],
    database: { name: 'db', url: 'postgres://u:p@db.example.com/app' }
  });
  const api = renderEnvFile({
    projectName: 'api',
    environmentName: 'staging',
    vars: [{ key: 'SMOKE_API', value: 'staging' }]
  });
  return variant === 'a'
    ? { 'web-production': web, 'api-staging': api }
    : { 'web-production': web };
}

function baseSecrets(pub: string): SandboxSecrets {
  return {
    authorizedKeys: [pub],
    githubToken: null,
    claudeToken: null,
    openaiToken: null,
    setupScript: 'echo setup-ran >> ~/setup-marker\nid -un > ~/setup-user\n',
    mcpToken: null,
    opencodePassword: 'smoke-opencode-password',
    bridgeToken: '',
    attachedEnv: envBundle('a'),
    gitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com' }
  };
}

async function waitFor(what: string, timeoutMs: number, fn: () => boolean, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sshdListening(box: Box): boolean {
  return box.ok(`ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)22$'`);
}

async function waitReady(box: Box, timeoutMs: number, logs: () => string) {
  const started = Date.now();
  try {
    await waitFor(`${box.suite} boot`, timeoutMs, () => {
      return box.out(`cat ${SANDBOX_PHASE_FILE} 2>/dev/null`) === 'ready' && sshdListening(box);
    });
  } catch (e) {
    process.stdout.write(`\n--- ${box.suite} bootstrap log ---\n${logs()}\n---\n`);
    throw e;
  }
  return Math.round((Date.now() - started) / 1000);
}

const BOOT_TOOLS = [
  'tmux',
  'sshd',
  'git',
  'curl',
  'rg',
  'ss',
  'pgrep',
  'sudo',
  'mountpoint',
  'infocmp',
  'python3',
  'jq',
  'node'
];

const OPENCODE_PIDS =
  'ps -eo pid=,args= | awk \'$2 ~ /bash$/ && $3 == "/usr/local/bin/opencode" && $4 == "serve" {print $1}\'';

async function bootChecks(
  box: Box,
  opts: { vercel: boolean; priv: string; identity: { name: string; email: string } }
) {
  const s = box.suite;
  await attempt(s, 'boot phase file is ready', () =>
    eq(box.out(`cat ${SANDBOX_PHASE_FILE}`), 'ready', 'phase')
  );
  await attempt(s, 'dev user exists with /persist/home', () => {
    const entry = box.out('getent passwd dev');
    assert(entry, 'no dev user');
    const [, , uid, , , home, shell] = entry.split(':');
    eq(home, HOME_ROOT, 'home');
    eq(shell, '/bin/bash', 'shell');
    return `uid ${uid}`;
  });
  await attempt(s, '/persist/home is owned by dev and writable', () => {
    eq(box.out('stat -c %U /persist/home'), 'dev', 'owner');
    assert(
      box.dev('touch ~/.smoke-write && rm ~/.smoke-write').code === 0,
      'dev cannot write home'
    );
  });
  if (opts.vercel) {
    await attempt(s, '/persist links to SANDBOX_PERSIST_ROOT', () =>
      eq(box.out('readlink /persist'), VERCEL_PERSIST_ROOT, 'link')
    );
    await attempt(s, 'staged init files moved to /orchard-init with secret modes', () => {
      assert(!box.ok(`[ -e ${VERCEL_INIT_STAGE} ]`), 'stage dir still exists');
      const modes = box.out('stat -c "%n %a" /orchard-init/* | sort');
      for (const name of ['opencode-password', 'bridge-token', 'orchard-env']) {
        assert(modes.includes(`/orchard-init/${name} 600`), `${name} is not 600:\n${modes}`);
      }
      assert(modes.includes('/orchard-init/bootstrap.sh 644'), `bootstrap.sh mode:\n${modes}`);
      assert(!box.ok('ls -A /orchard-init | grep -q "^\\."'), 'leftover .tmp files');
    });
  }
  await attempt(s, 'boot tools are installed', () => {
    const missing = BOOT_TOOLS.filter(
      (t) => !box.ok(`command -v ${t} >/dev/null || [ -x /usr/sbin/${t} ]`)
    );
    assert(!missing.length, `missing: ${missing.join(' ')}`);
    return box.out('node --version; git --version | cut -d" " -f3; tmux -V').replace(/\n/g, ', ');
  });
  await attempt(s, '/etc/tmux.conf content', () => {
    const term = box.ok('infocmp tmux-256color >/dev/null 2>&1')
      ? 'tmux-256color'
      : 'screen-256color';
    const expected = [
      `set -g default-terminal "${term}"`,
      'set -ga terminal-overrides ",xterm-256color:Tc"',
      'set -ga terminal-overrides ",xterm*:smcup@:rmcup@"',
      'set -g history-limit 50000',
      'set -g mouse off',
      'set -g status off',
      'set -sg escape-time 0'
    ].join('\n');
    eq(box.out('cat /etc/tmux.conf'), expected, 'tmux.conf');
    eq(box.out('stat -c %a /etc/tmux.conf'), '644', 'mode');
    assert(
      box.dev('tmux -f /etc/tmux.conf new-session -d -s smoke-conf true && tmux kill-server; true')
        .code === 0,
      'tmux'
    );
    assert(
      box.dev(
        [
          "tmux -f /etc/tmux.conf new-session -d -s smoke-base 'sleep 30' \\; set-option -g mouse on",
          `${TMUX_TERMINAL} new-session -d -s smoke-opts 'sleep 30'`,
          'tmux show-options -gv mouse | grep -qx off',
          "tmux show-options -sv 'terminal-overrides[90]' | grep -q 'smcup@'"
        ].join(' && ') + '; c=$?; tmux kill-server; exit $c'
      ).code === 0,
      'terminal tmux clients turn mouse reporting and the alternate screen off'
    );
    return term;
  });
  await attempt(s, 'sshd listens on 22 and accepts the authorized key for dev only', () => {
    assert(sshdListening(box), 'nothing on :22');
    box.write('/root/.smoke-ssh/id', opts.priv, '600');
    const ssh = (user: string) =>
      box.sh(
        `ssh -i /root/.smoke-ssh/id -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 ${user}@127.0.0.1 'id -un; echo $HOME'`
      );
    const dev = ssh('dev');
    eq(dev.stdout.trim().split('\n'), ['dev', HOME_ROOT], `ssh dev (${dev.stderr.trim()})`);
    assert(ssh('root').code !== 0, 'root login was allowed');
    const fp = box.out('ssh-keygen -lf /persist/hostkeys/ssh_host_ed25519_key.pub | cut -d" " -f2');
    return `host key ${fp}`;
  });
  await attempt(s, 'dev has passwordless sudo', () => {
    eq(box.dev('sudo -n id -u').stdout.trim(), '0', 'sudo id');
  });
  await attempt(s, 'opencode serve started once as dev with the right password', () => {
    eq(box.out(`${OPENCODE_PIDS} | wc -l`), '1', 'opencode serve processes');
    eq(box.out('cat /tmp/opencode-stub-user'), 'dev', 'user');
    eq(box.out('cat /tmp/opencode-stub-args'), 'serve --hostname 0.0.0.0 --port 4096', 'args');
    const expected = opts.vercel ? 'smoke-opencode-password' : '';
    eq(box.out('cat /tmp/opencode-stub-password'), expected, 'password');
    if (opts.vercel) {
      eq(
        box.out('stat -c "%U %a" /persist/home/.config/opencode/server.env'),
        'dev 600',
        'server.env'
      );
    } else {
      assert(
        !box.ok('[ -e /persist/home/.config/opencode/server.env ]'),
        'server.env exists on k8s'
      );
    }
    eq(
      box.out('readlink /persist/home/.config/opencode/opencode.json'),
      '/orchard-init/opencode-config.json',
      'config link'
    );
    eq(
      box.out('readlink /persist/home/.local/share/opencode/auth.json'),
      '/orchard-init/opencode-auth.json',
      'auth link'
    );
    eq(
      box.out('stat -c %U /orchard-init/opencode-config.json'),
      box.out('stat -c %U /orchard-init/bootstrap.sh'),
      'init owner untouched'
    );
  });
  await attempt(s, 'git identity applied to dev git config', () => {
    eq(box.dev('git config --global user.name').stdout.trim(), opts.identity.name, 'name');
    eq(box.dev('git config --global user.email').stdout.trim(), opts.identity.email, 'email');
    eq(
      box.out('cat /persist/home/.config/orchard/git-identity'),
      `${opts.identity.name}\n${opts.identity.email}`,
      'marker'
    );
    eq(box.out('stat -c %U /persist/home/.gitconfig'), 'dev', 'owner');
  });
  await attempt(
    s,
    'attached env files are 0600 dev and sourced by login and interactive shells',
    () => {
      const listing = box.out(
        'cd /persist/home/.config/orchard/env && stat -c "%n %U %a" * | sort'
      );
      eq(listing.split('\n'), ['api-staging.env dev 600', 'web-production.env dev 600'], 'files');
      eq(
        box.out('stat -c "%a" /persist/home/.config/orchard /persist/home/.config/orchard/env'),
        '700\n700',
        'dir modes'
      );
      const login = box.dev(
        'printf "%s|%s|%s|%s\\n" "$SMOKE_GREETING" "$SMOKE_API" "$DATABASE_URL" "$SMOKE_SPACES"; echo "$PATH"; echo "${SMOKE_SECRET-unset}"'
      );
      const [vals, path, secret] = login.stdout.trim().split('\n');
      eq(
        vals,
        `it's alive|staging|postgres://u:p@db.example.com/app|a b  $HOME \`id\` "q"`,
        'login env'
      );
      assert(!path.includes('/evil'), `PATH overridden: ${path}`);
      eq(secret, 'unset', 'secret');
      const interactive = box.sh(`su dev -c 'bash -ic "echo \\$SMOKE_GREETING" 2>/dev/null'`);
      eq(interactive.stdout.trim().split('\n').pop(), "it's alive", 'interactive env');
    }
  );
  await attempt(s, 'setup.sh ran once as dev', async () => {
    await waitFor('setup', 60_000, () => box.ok('[ -f /persist/.setup-done ]'), 1000);
    eq(box.out('cat /persist/home/setup-user'), 'dev', 'user');
    eq(box.out('cat /persist/home/setup-marker'), 'setup-ran', 'marker');
    assert(box.out('cat /persist/home/.setup.log').includes('[setup] completed'), 'log');
  });
}

async function rerunChecks(
  box: Box,
  run: () => Promise<{ code: number | null; seconds: number; log: string }>
) {
  const s = box.suite;
  box.sh('echo "export SMOKE_CUSTOM=kept" >> /persist/home/.bashrc');
  const sshdBefore = box.out('pgrep -x sshd | sort | head -1');
  const opencodeBefore = box.out(OPENCODE_PIDS);
  const r = await run();
  await attempt(s, 'second bootstrap run exits 0 quickly', () => {
    eq(r.code, 0, `exit (log: ${r.log.trim().slice(-500)})`);
    assert(r.seconds < 30, `took ${r.seconds}s`);
    return `${r.seconds}s`;
  });
  await attempt(s, 'second run is idempotent', () => {
    eq(box.out(`cat ${SANDBOX_PHASE_FILE}`), 'ready', 'phase');
    eq(box.out('pgrep -x sshd | sort | head -1'), sshdBefore, 'sshd pid');
    eq(box.out(OPENCODE_PIDS), opencodeBefore, 'opencode pids');
    eq(box.out("grep -c 'orchard-env.sh' /persist/home/.bashrc"), '1', 'bashrc hook count');
    eq(
      box.out("grep -c '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config"),
      '1',
      'sshd Include count'
    );
    eq(box.out('cat /persist/home/setup-marker'), 'setup-ran', 'setup ran again');
    assert(
      box.ok("grep -q 'SMOKE_CUSTOM=kept' /persist/home/.bashrc"),
      'a customised ~/.bashrc was overwritten by /etc/skel'
    );
  });
}

interface SessionEnv {
  box: Box;
  runner: SandboxRunner;
  sandbox: any;
}

function services(
  env: SessionEnv,
  actor: GitActor,
  dirs: Map<string, { dir: string; guardRoot: string | null }>
) {
  const registry = { for: () => env.runner };
  const workspace: any = Object.create(SandboxWorkspaceService.prototype);
  workspace.registry = registry;
  workspace.gitActors = {
    resolve: async () => actor,
    requireToken: (a: GitActor) => {
      if (!a.token) throw new Error('no token');
      return a.token;
    }
  };
  workspace.resolveDir = async (_sandbox: unknown, selector: any) => {
    const key =
      typeof selector === 'string'
        ? `repo:${selector}`
        : selector?.session
          ? `session:${selector.session}`
          : `repo:${selector?.repo ?? ''}`;
    const hit = dirs.get(key);
    if (!hit) throw new Error(`no dir for ${key}`);
    return { ...hit, session: null };
  };
  const sessions: any = Object.create(SandboxSessionsService.prototype);
  sessions.registry = registry;
  sessions.workspace = workspace;
  sessions.logger = new Logger('smoke');
  sessions.prisma = {
    sandbox: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) }
  };
  return { workspace, sessions };
}

async function expectRejects(p: Promise<unknown>, pattern: RegExp, what: string) {
  try {
    await p;
  } catch (e: any) {
    const msg = String(e?.response?.message ?? e?.message ?? e);
    if (!pattern.test(msg)) throw new Error(`${what}: unexpected error ${msg}`);
    return;
  }
  throw new Error(`${what}: was allowed`);
}

async function sessionChecks(env: SessionEnv) {
  const { box, runner, sandbox } = env;
  const s = `${box.suite}/helpers`;
  const ref = { ...sandbox, runnerState: null };
  const devExec = (script: string, stdin?: Buffer) =>
    runner.exec(ref, ['su', '-l', 'dev', '-c', script], {
      timeoutMs: 60_000,
      ...(stdin ? { stdin } : {})
    });
  const s1 = randomUUID();
  const s2 = randomUUID();
  const ghost = randomUUID();
  const slug1 = `fix-login-${s1.slice(0, 8)}`;
  const slug2 = `docs-${s2.slice(0, 8)}`;
  const wt1 = worktreePathFor('app', slug1);
  const wt2 = worktreePathFor('app', slug2);
  const actor: GitActor = {
    userId: randomUUID(),
    identity: { name: 'Grace Hopper', email: 'grace@example.com' },
    githubLogin: 'grace',
    token: 'ghs_smokeToken123'
  };
  const dirs = new Map<string, { dir: string; guardRoot: string | null }>([
    [`session:${s1}`, { dir: wt1, guardRoot: WORKTREES_ROOT }],
    [`session:${s2}`, { dir: wt2, guardRoot: WORKTREES_ROOT }],
    ['repo:app', { dir: `${HOME_ROOT}/app`, guardRoot: null }]
  ]);
  const { workspace, sessions } = services(env, actor, dirs);
  const greeting = box.dev('echo "$SMOKE_GREETING"').stdout.trim();
  const sessionRows = new Map<string, any>([
    [
      s1,
      {
        id: s1,
        sandboxId: sandbox.id,
        repo: 'app',
        slug: slug1,
        worktreePath: wt1,
        archivedAt: null
      }
    ]
  ]);
  sessions.prisma.sandboxConversation = {
    findFirst: async ({ where }: any) => sessionRows.get(where.id) ?? null
  };
  const seed = await devExec(
    [
      'set -e',
      'rm -rf /tmp/smoke-origin.git ~/app ~/.worktrees/app',
      'git init -q --bare -b main /tmp/smoke-origin.git',
      'git clone -q /tmp/smoke-origin.git ~/app 2>/dev/null',
      'cd ~/app',
      "printf 'line1\\nline2\\nline3\\n' > README.md",
      'mkdir -p src && echo a > src/a.txt',
      'git add -A',
      'git -c user.name=Seed -c user.email=seed@example.com commit -qm init',
      'git push -q origin main 2>/dev/null',
      'git remote set-head origin -a >/dev/null',
      'git rev-parse HEAD'
    ].join('\n')
  );
  const seedCommit = seed.stdout.trim();
  if (
    !record(s, 'seed repo with origin', seed.ok && /^[0-9a-f]{40}$/.test(seedCommit), seed.stderr)
  )
    return;

  let added = { baseBranch: null as string | null, baseCommit: null as string | null };
  await attempt(s, 'worktree add (default base from origin/HEAD)', async () => {
    const r = await devExec(buildWorktreeAddScript({ repo: 'app', slug: slug1, baseBranch: null }));
    eq(r.exitCode, 0, `exit (${r.stderr.trim()})`);
    added = parseWorktreeAddOutput(r.stdout);
    eq(added, { baseBranch: 'main', baseCommit: seedCommit }, 'parsed');
    eq(
      box.dev(`git -C ${wt1} rev-parse --abbrev-ref HEAD`).stdout.trim(),
      sessionBranch(slug1),
      'branch'
    );
    eq(box.out(`stat -c %U ${wt1}`), 'dev', 'owner');
  });
  await attempt(s, 'worktree add refuses an existing path and an unknown base', async () => {
    eq(
      (await devExec(buildWorktreeAddScript({ repo: 'app', slug: slug1, baseBranch: null })))
        .exitCode,
      4,
      'exists'
    );
    eq(
      (await devExec(buildWorktreeAddScript({ repo: 'app', slug: 'nope-x', baseBranch: 'nope' })))
        .exitCode,
      5,
      'no base'
    );
    eq(
      (await devExec(buildWorktreeAddScript({ repo: 'missing', slug: 'x-y', baseBranch: null })))
        .exitCode,
      3,
      'not repo'
    );
  });
  await attempt(s, 'worktree add with an explicit base', async () => {
    const r = await devExec(
      buildWorktreeAddScript({ repo: 'app', slug: slug2, baseBranch: 'main' })
    );
    eq(r.exitCode, 0, `exit (${r.stderr.trim()})`);
    eq(parseWorktreeAddOutput(r.stdout).baseBranch, 'main', 'base');
  });

  await attempt(s, 'commit through the identity prelude uses the actor', async () => {
    const r = await workspace.runGit(
      sandbox,
      { session: s1 },
      actor.userId,
      (git: string) =>
        `printf 'f1\\nf2\\n' > feature.txt && ${git} add feature.txt && ${git} commit -qm feature && ${git} log -1 --format='%an <%ae>|%cn <%ce>'`
    );
    eq(r.exitCode, 0, `exit ${r.stdout}`);
    eq(
      r.stdout.trim(),
      'Grace Hopper <grace@example.com>|Grace Hopper <grace@example.com>',
      'author|committer'
    );
    assert(
      box.dev('git config --global user.email').stdout.trim() !== 'grace@example.com',
      'global identity was rewritten'
    );
  });

  box.dev(
    [
      'set -e',
      'cd ~/app && echo upstream > upstream.txt && git add upstream.txt',
      'git -c user.name=Seed -c user.email=seed@example.com commit -qm upstream && git push -q origin main 2>/dev/null',
      `cd ${wt1} && printf 'line1\\nchanged\\nline3\\n' > README.md && echo n > notes.md`
    ].join('\n')
  );
  await attempt(s, 'diffstat batch parsed by parseDiffstatBatch', async () => {
    const stats: Map<string, any> = await sessions.batchStats(sandbox, [
      { id: s1, worktreePath: wt1, baseBranch: 'main', baseCommit: added.baseCommit },
      { id: s2, worktreePath: wt2, baseBranch: 'main', baseCommit: added.baseCommit },
      {
        id: ghost,
        worktreePath: worktreePathFor('app', 'gone-1234'),
        baseBranch: 'main',
        baseCommit: null
      }
    ]);
    eq(
      stats.get(s1),
      { diffstat: { files: 3, additions: 3, deletions: 1 }, aheadBehind: { behind: 1, ahead: 1 } },
      'session 1'
    );
    eq(
      stats.get(s2),
      { diffstat: { files: 0, additions: 0, deletions: 0 }, aheadBehind: { behind: 1, ahead: 0 } },
      'session 2'
    );
    eq(stats.get(ghost), { diffstat: null, aheadBehind: null }, 'missing worktree');
  });

  box.dev(
    [
      "printf 'https://x-access-token:host-secret@github.com\\n' > ~/.git-credentials && chmod 600 ~/.git-credentials",
      `cd ${wt1}`,
      'ln -sfn /persist/home/.git-credentials creds',
      'ln -sfn /etc etclink',
      'ln -sfn /persist/home homelink',
      `ln -sfn ../${slug2} sibling`,
      'ln -sfn ../.git-credentials ~/app/creds'
    ].join('\n')
  );
  const outside = /outside the workspace/;
  await attempt(s, 'fs mkdir/rename/delete inside the worktree', async () => {
    await workspace.fsOp(sandbox, 'mkdir', { session: s1, path: 'src/new/dir' });
    assert(box.ok(`[ -d ${wt1}/src/new/dir ]`), 'mkdir');
    await expectRejects(
      workspace.fsOp(sandbox, 'mkdir', { session: s1, path: 'src/new/dir' }),
      /already exists/,
      'mkdir twice'
    );
    await workspace.fsOp(sandbox, 'rename', {
      session: s1,
      path: 'src/a.txt',
      to: 'docs/moved/a.txt'
    });
    eq(box.out(`cat ${wt1}/docs/moved/a.txt`), 'a', 'renamed content');
    await workspace.fsOp(sandbox, 'rename', {
      session: s1,
      path: 'docs/moved',
      to: 'docs/renamed'
    });
    assert(box.ok(`[ -f ${wt1}/docs/renamed/a.txt ]`), 'dir rename (mv -T)');
    await expectRejects(
      workspace.fsOp(sandbox, 'rename', { session: s1, path: 'notes.md', to: 'docs/renamed' }),
      /already exists/,
      'rename onto dir'
    );
    await workspace.fsOp(sandbox, 'delete', { session: s1, path: 'docs' });
    assert(!box.ok(`[ -e ${wt1}/docs ]`), 'delete');
    await expectRejects(
      workspace.fsOp(sandbox, 'delete', { session: s1, path: 'docs' }),
      /Nothing exists/,
      'delete missing'
    );
  });
  await attempt(s, 'fs ops through outside-pointing symlinks are refused', async () => {
    await expectRejects(
      workspace.fsOp(sandbox, 'mkdir', { session: s1, path: 'etclink/smoke' }),
      outside,
      'mkdir etclink/smoke'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'mkdir', { session: s1, path: 'homelink/evil' }),
      outside,
      'mkdir homelink/evil'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'rename', { session: s1, path: 'notes.md', to: 'etclink/notes.md' }),
      outside,
      'rename into /etc'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'rename', {
        session: s1,
        path: 'homelink/.git-credentials',
        to: 'stolen'
      }),
      outside,
      'rename ~/.git-credentials'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'rename', { session: s1, path: 'sibling/README.md', to: 'stolen' }),
      outside,
      'rename sibling file'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'delete', { session: s1, path: 'homelink/.git-credentials' }),
      outside,
      'delete ~/.git-credentials'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'delete', { session: s1, path: 'etclink/hostname' }),
      outside,
      'delete /etc/hostname'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'delete', { session: s1, path: 'sibling/README.md' }),
      outside,
      'delete sibling file'
    );
    await expectRejects(
      workspace.fsOp(sandbox, 'delete', { repo: 'app', path: 'creds/x' }),
      outside,
      'repo delete through link'
    );
    assert(
      box.ok(
        `[ -f ${wt2}/README.md ] && [ -s /persist/home/.git-credentials ] && [ -f /etc/hostname ]`
      ),
      'targets changed'
    );
    await workspace.fsOp(sandbox, 'delete', { session: s1, path: 'homelink' });
    await workspace.fsOp(sandbox, 'delete', { session: s1, path: 'creds' });
    await workspace.fsOp(sandbox, 'delete', { repo: 'app', path: 'creds' });
    assert(
      box.ok(
        `[ ! -e ${wt1}/homelink ] && [ ! -L ${wt1}/creds ] && [ -s /persist/home/.git-credentials ] && [ -d /persist/home/app ]`
      ),
      'deleting the link removed its target'
    );
    box.dev(
      `cd ${wt1} && ln -sfn /persist/home homelink && ln -sfn /persist/home/.git-credentials creds`
    );
  });
  await attempt(s, 'reads and diffs through outside-pointing symlinks are refused', async () => {
    const read = await workspace.readFile(sandbox, { session: s1 }, 'README.md');
    eq(read.content, 'line1\nchanged\nline3\n', 'README');
    for (const file of [
      'creds',
      'etclink/passwd',
      'homelink/.bashrc',
      'homelink/.git-credentials',
      'sibling/README.md'
    ]) {
      await expectRejects(
        workspace.readFile(sandbox, { session: s1 }, file),
        outside,
        `read ${file}`
      );
      await expectRejects(workspace.diff(sandbox, file, { session: s1 }), outside, `diff ${file}`);
    }
    box.dev('ln -sfn ../.git-credentials ~/app/creds');
    await expectRejects(
      workspace.readFile(sandbox, 'app', 'creds'),
      outside,
      'repo read ~/.git-credentials'
    );
    await expectRejects(
      workspace.readFile(sandbox, 'app', '../.git-credentials'),
      /Invalid/,
      'dotdot'
    );
  });
  await attempt(s, 'workdir realpath guard refuses a worktree that is a symlink out', async () => {
    box.dev('mkdir -p ~/.worktrees/app && ln -sfn /etc ~/.worktrees/app/evil-link');
    const r = await workspace.runIn(
      sandbox,
      `${WORKTREES_ROOT}/app/evil-link`,
      WORKTREES_ROOT,
      'ls passwd'
    );
    eq(r.exitCode, 3, 'exit');
    box.dev('rm -f ~/.worktrees/app/evil-link');
  });

  await attempt(s, 'credential reset ignores inherited helpers (token path)', async () => {
    const helper = (tag: string) =>
      `!f(){ touch /tmp/marker-${tag}; echo username=leak; echo password=leak-${tag}; }; f`;
    box.sh(
      `rm -f /tmp/marker-*; git config --system credential.helper ${shellQuote(helper('system'))}`
    );
    box.dev(
      `git config --global --add credential.helper ${shellQuote(helper('global'))}; git -C ~/app config credential.helper ${shellQuote(helper('local'))}`
    );
    const r = await workspace.runGit(
      sandbox,
      { session: s1 },
      actor.userId,
      (git: string) => `printf 'protocol=https\\nhost=github.com\\n\\n' | ${git} credential fill`,
      { network: true }
    );
    eq(r.exitCode, 0, `exit ${r.stdout}`);
    assert(
      r.stdout.includes('username=x-access-token') && r.stdout.includes(`password=${actor.token}`),
      `fill output ${r.stdout}`
    );
    eq(box.out('ls /tmp/marker-* 2>/dev/null'), '', 'inherited helper markers');
  });
  await attempt(s, 'terminal env file resets helpers (with and without a token)', async () => {
    const fill =
      "printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill";
    for (const token of [actor.token, null]) {
      const id = randomUUID();
      const path = terminalEnvPath(id);
      const content = terminalEnvFile({ ...actor, token });
      const w = await devExec(writeTerminalEnvScript(path), Buffer.from(content));
      eq(w.exitCode, 0, 'write env');
      eq(box.out(`stat -c "%U %a" ${path}`), 'dev 600', 'env file mode');
      box.sh('rm -f /tmp/marker-*');
      const r = box.dev(
        `. ${path}; rm -f ${path}; cd ${wt1}; ${fill}; echo "exit=$?"; git var GIT_AUTHOR_IDENT | cut -d'>' -f1`
      );
      if (token) {
        assert(r.stdout.includes(`password=${token}`), `fill ${r.stdout} ${r.stderr}`);
      } else {
        assert(
          !r.stdout.includes('password='),
          `fill returned a password without a token: ${r.stdout}`
        );
      }
      assert(r.stdout.includes('Grace Hopper <grace@example.com'), `ident ${r.stdout}`);
      eq(box.out('ls /tmp/marker-* 2>/dev/null'), '', `markers (token ${token ? 'set' : 'unset'})`);
    }
    box.sh('git config --system --unset-all credential.helper; rm -f /tmp/marker-*');
    box.dev(
      'git config --global --unset-all credential.helper; git -C ~/app config --unset-all credential.helper; true'
    );
  });

  await attempt(
    s,
    'ports via /proc list dev listeners with session and loopback flags',
    async () => {
      box.dev(
        `cd ${wt1} && (nohup python3 -m http.server 3000 >/dev/null 2>&1 &) ; cd ~ && (nohup python3 -m http.server 3001 --bind 127.0.0.1 >/dev/null 2>&1 &)`
      );
      await waitFor(
        'listeners',
        20_000,
        () => {
          return box.ok("ss -ltnH | grep -q ':3000 ' && ss -ltnH | grep -q ':3001 '");
        },
        500
      );
      const ports = await sessions.ports(sandbox, s1).then((r: any) => r.ports);
      const p3000 = ports.find((p) => p.port === 3000);
      const p3001 = ports.find((p) => p.port === 3001);
      assert(p3000 && p3001, `ports ${JSON.stringify(ports)}`);
      eq([p3000.process, p3000.inSession, p3000.loopbackOnly], ['python3', true, false], '3000');
      eq([p3001.process, p3001.inSession, p3001.loopbackOnly], ['python3', false, true], '3001');
      const root = await runner.exec(ref, ['/bin/sh', '-c', buildPortsScript()], {
        timeoutMs: 15_000
      });
      const asRoot =
        parsePortsOutput(root.stdout, wt1)
          .map((p) => p.port)
          .join(',') || 'none';
      assert(!ports.some((p) => p.port === 22 || p.port === 4096), 'reserved ports listed');
      box.sh("pkill -f 'http.server 300[01]'");
      return `${ports.map((p: any) => p.port).join(',')}; the same script as root sees ${asRoot}`;
    }
  );

  const row1 = { id: s1, repo: 'app', slug: slug1, worktreePath: wt1 };
  await attempt(
    s,
    'greenhouse setup script runs in tmux with session env and attached env',
    async () => {
      box.dev(
        `mkdir -p ${wt1}/.orchard && cat > ${wt1}/.orchard/greenhouse.json <<'JSON'\n${JSON.stringify(
          {
            setup: [
              'echo setup-ok',
              'printf "%s|%s|%s\\n" "$ORCHARD_SESSION_ID" "$ORCHARD_WORKSPACE_PATH" "$SMOKE_GREETING" > setup-env.txt'
            ],
            run: 'exec python3 -m http.server 3002',
            ports: [3002, 22]
          }
        )}\nJSON`
      );
      const probe = await sessions.probeScripts(sandbox, row1);
      eq(probe.config.ports, [3002], 'declared ports');
      assert(probe.config.setup?.includes('setup-ok'), 'setup parsed');
      await sessions.startScript(sandbox, row1, 'setup');
      const status = `${sessionStateDir(s1)}/setup.status`;
      await waitFor(
        'setup status',
        30_000,
        () => box.out(`cat ${status} 2>/dev/null`) === 'done',
        500
      );
      eq(box.out(`cat ${wt1}/setup-env.txt`), `${s1}|${wt1}|${greeting}`, 'script env');
      await waitFor(
        'setup log',
        10_000,
        () => box.out(`cat ${sessionStateDir(s1)}/setup.log`).includes('setup-ok'),
        500
      );
      eq(box.out(`stat -c %U ${sessionStateDir(s1)}/setup.sh`), 'dev', 'wrapper owner');
    }
  );
  await attempt(s, 'greenhouse run script stays up, then stops', async () => {
    await sessions.startScript(sandbox, row1, 'run');
    await waitFor('run listener', 20_000, () => box.ok("ss -ltnH | grep -q ':3002 '"), 500);
    const live = await sessions.probeScripts(sandbox, row1);
    eq(live.runPaneDead, '0', 'pane alive');
    await devExec(buildScriptStop(s1, 'run'));
    const stopped = await sessions.probeScripts(sandbox, row1);
    eq(stopped.runPaneDead, null, 'pane after stop');
    await waitFor('run listener gone', 10_000, () => !box.ok("ss -ltnH | grep -q ':3002 '"), 500);
  });

  await attempt(s, 'worktree restore and remove (tmux, branch, state)', async () => {
    box.dev(`rm -rf ${wt2}`);
    const restore = await devExec(buildWorktreeRestoreScript('app', slug2));
    eq(restore.exitCode, 0, `restore (${restore.stderr.trim()})`);
    eq(
      box.dev(`git -C ${wt2} rev-parse --abbrev-ref HEAD`).stdout.trim(),
      sessionBranch(slug2),
      'restored branch'
    );
    box.dev(
      `tmux new-session -d -s ${tmuxSessionName(s2, '0')} 'sleep 600'; mkdir -p ${sessionStateDir(s2)}`
    );
    const rm = await devExec(
      buildWorktreeRemoveScript('app', slug2, s2, { deleteBranch: true, purgeState: true })
    );
    eq(rm.exitCode, 0, 'remove');
    assert(!box.ok(`[ -e ${wt2} ]`), 'worktree still there');
    assert(
      box.dev(
        `git -C ${HOME_ROOT}/app rev-parse --verify --quiet refs/heads/${sessionBranch(slug2)}`
      ).code === 1,
      'branch kept'
    );
    assert(
      !box.ok(`su dev -c 'tmux has-session -t =${tmuxSessionName(s2, '0')}' 2>/dev/null`),
      'tmux kept'
    );
    assert(!box.ok(`[ -e ${sessionStateDir(s2)} ]`), 'state kept');
    assert(box.ok(`[ -d ${wt1} ]`), 'other worktree removed');
  });
}

function k8sRunner(box: Box): SandboxRunner {
  const runner: any = Object.create(KubernetesSandboxRunner.prototype);
  runner.forkProbe = { running: true, at: Date.now() };
  runner.run = async (
    _ref: unknown,
    command: string[],
    opts: { stdin?: Buffer; timeoutMs?: number } = {}
  ) => {
    const cmd: string[] = runner.wrapCommand(command, opts);
    const r = docker(['exec', ...(opts.stdin ? ['-i'] : []), box.name, ...cmd], {
      input: opts.stdin,
      timeoutMs: opts.timeoutMs
    });
    return { stdout: r.out, stderr: r.err, exitCode: r.code, ok: r.code === 0 };
  };
  return runner;
}

class DockerVercelSession implements VercelSessionLike {
  private seq = 0;
  readonly detached: string[] = [];

  constructor(private readonly box: Box) {}

  domain(port: number): string {
    return `smoke-${port}.vercel.run`;
  }

  async writeFiles(files: { path: string; content: Uint8Array; mode?: number }[]): Promise<void> {
    for (const file of files) {
      const r = docker(
        [
          'exec',
          '-i',
          this.box.name,
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"',
          'sh',
          file.path,
          (file.mode ?? 0o644).toString(8)
        ],
        { input: Buffer.from(file.content) }
      );
      if (r.code !== 0) throw new Error(`writeFiles ${file.path}: ${r.stderr}`);
    }
  }

  async runCommand(params: VercelRunCommandParams): Promise<VercelCommandLike> {
    const env = Object.entries(params.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const argv = [params.cmd, ...(params.args ?? [])];
    if (params.detached) {
      const tag = `${++this.seq}`;
      this.detached.push(tag);
      docker([
        'exec',
        '-d',
        ...env,
        this.box.name,
        '/bin/sh',
        '-c',
        'tag=$1; shift; "$@" >> /tmp/smoke-cmd-$tag.log 2>&1; echo $? > /tmp/smoke-cmd-$tag.exit',
        'sh',
        tag,
        ...argv
      ]);
      return this.command(null, '', '');
    }
    const r = docker(['exec', ...env, this.box.name, ...argv], { timeoutMs: params.timeoutMs });
    return this.command(r.code, r.stdout, r.stderr);
  }

  private command(exitCode: number | null, stdout: string, stderr: string): VercelCommandLike {
    return {
      exitCode,
      wait: async () => ({ exitCode: exitCode ?? 0 }),
      stdout: async () => stdout,
      stderr: async () => stderr,
      logs: () => ({ async *[Symbol.asyncIterator]() {} }),
      kill: async () => {}
    };
  }

  async readFileToBuffer(): Promise<Buffer | null> {
    return null;
  }

  async extendTimeout(): Promise<void> {}
}

function vercelRunner(
  session: DockerVercelSession,
  bridgeUrl: string,
  sha: () => string | null
): any {
  const runner: any = Object.create(VercelSandboxRunner.prototype);
  runner.withSession = async (_ref: unknown, fn: (s: VercelSessionLike) => Promise<unknown>) =>
    fn(session);
  runner.settings = () => ({ bridgeUrl });
  runner.bridgeSha256 = async () => sha();
  return runner;
}

function sandboxRow(runner: 'kubernetes' | 'vercel', podName: string) {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    runner,
    podName,
    namespace: runner === 'kubernetes' ? 'orchard-sandboxes' : null,
    externalId: null,
    runnerState: null,
    status: 'running',
    repoUrl: null
  };
}

async function runK8s(
  opts: Options,
  work: string,
  stubs: Record<string, string>,
  keys: { priv: string; pub: string },
  tag: string
) {
  const suite = 'k8s';
  process.stdout.write(`\n== ${suite}: ${opts.k8sImage} ==\n`);
  const secrets = baseSecrets(keys.pub);
  const runner: any = Object.create(KubernetesSandboxRunner.prototype);
  Object.defineProperty(runner, 'namespace', { value: 'orchard-sandboxes' });
  const prevMode = process.env.SANDBOX_HOME_MODE;
  process.env.SANDBOX_HOME_MODE = 'filesystem';
  const row = sandboxRow('kubernetes', `sbx-smoke-${tag}`);
  const cr = runner.buildCr(
    {
      ...row,
      repoUrl: opts.repoUrl || null,
      image: opts.k8sImage,
      cpuLimit: '2',
      memoryLimit: '4Gi',
      diskSize: '10Gi',
      setupScript: secrets.setupScript
    },
    'smoke'
  );
  if (prevMode === undefined) delete process.env.SANDBOX_HOME_MODE;
  else process.env.SANDBOX_HOME_MODE = prevMode;
  const data: Record<string, string> = runner.secretData(secrets);
  const pod = cr.spec.podTemplate.spec;
  const container = pod.containers[0];
  const volumes = new Map<string, any>(pod.volumes.map((v: any) => [v.name, v]));
  const mounts: string[] = [];
  const missingKeys: string[] = [];
  for (const vm of container.volumeMounts) {
    const vol = volumes.get(vm.name);
    if (!vol?.secret) continue;
    const dir = join(work, `k8s-${vm.name}`);
    mkdirSync(dir, { recursive: true });
    for (const item of vol.secret.items) {
      if (!(item.key in data)) {
        missingKeys.push(item.key);
        continue;
      }
      const path = join(dir, item.path);
      writeFileSync(path, data[item.key]);
      chmodSync(path, item.mode ?? vol.secret.defaultMode ?? 0o644);
    }
    mounts.push('-v', `${dir}:${vm.mountPath}${vm.readOnly ? ':ro' : ''}`);
  }
  record(
    suite,
    'every secret volume item has a key in secretData',
    missingKeys.length === 0,
    missingKeys.join(' ')
  );
  const homeMount = container.volumeMounts.find((vm: any) => vm.name === 'home');
  record(
    suite,
    'filesystem home mode mounts the PVC at /persist',
    homeMount?.mountPath === '/persist',
    JSON.stringify(homeMount)
  );
  const envArgs: string[] = [];
  for (const e of container.env) {
    if (e.valueFrom?.secretKeyRef) {
      const v = data[e.valueFrom.secretKeyRef.key];
      if (v !== undefined) envArgs.push('-e', `${e.name}=${v}`);
    } else envArgs.push('-e', `${e.name}=${e.value ?? ''}`);
  }
  const volume = `orchard-smoke-${tag}`;
  docker(['volume', 'create', '--label', 'orchard-smoke=1', volume]);
  created.volumes.add(volume);
  const start = (name: string) => {
    const r = docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'orchard-smoke=1',
      '--hostname',
      row.podName,
      '-v',
      `${volume}:/persist`,
      ...mounts,
      ...stubMounts(stubs),
      ...envArgs,
      '--entrypoint',
      container.command[0],
      opts.k8sImage,
      ...container.command.slice(1)
    ]);
    if (r.code !== 0) throw new Error(`docker run: ${r.stderr}`);
    created.containers.add(name);
    return new Box(name, suite);
  };
  return { suite, row, start, secrets };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tag = randomBytes(3).toString('hex');
  const work = mkdtempSync(join(tmpdir(), 'orchard-smoke-'));
  const onSignal = () => {
    cleanup(opts.keep);
    rmSync(work, { recursive: true, force: true });
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  Logger.overrideLogger(['error']);
  const started = Date.now();
  try {
    const images = new Set([
      ...(opts.only !== 'vercel' ? [opts.k8sImage] : []),
      ...(opts.only !== 'k8s' ? [opts.vercelImage] : [])
    ]);
    for (const image of images) {
      if (docker(['image', 'inspect', image]).code !== 0) {
        throw new Error(`${image} is not present locally; this smoke never pulls images`);
      }
    }
    const stubs = stubFiles(join(work, 'stubs'), opts);
    const keys = sshKeypair(work);
    const jobs: Array<() => Promise<void>> = [];

    let k8sBox: Box | null = null;
    let k8s: Awaited<ReturnType<typeof runK8s>> | null = null;
    if (opts.only !== 'vercel') {
      k8s = await runK8s(opts, work, stubs, keys, tag);
      k8sBox = k8s.start(`orchard-smoke-k8s-${tag}`);
    }

    let vBox: Box | null = null;
    let vSession: DockerVercelSession | null = null;
    let vRunner: any = null;
    let vSha: string | null = null;
    const vRow = sandboxRow('vercel', `sbx-smoke-${tag}`);
    const vSecrets: SandboxSecrets = {
      ...baseSecrets(keys.pub),
      bridgeToken: 'smoke-bridge-token'
    };
    if (opts.only !== 'k8s') {
      const name = `orchard-smoke-vercel-${tag}`;
      const r = docker([
        'run',
        '-d',
        '--name',
        name,
        '--label',
        'orchard-smoke=1',
        '--hostname',
        vRow.podName,
        ...stubMounts(stubs),
        '--entrypoint',
        'sleep',
        opts.vercelImage,
        'infinity'
      ]);
      if (r.code !== 0) throw new Error(`docker run: ${r.stderr}`);
      created.containers.add(name);
      vBox = new Box(name, 'vercel');
      vBox.sh('rm -f /etc/skel/.profile');
      vBox.write(
        '/opt/smoke-bridge/orchard',
        '#!/bin/bash\nprintf "%s\\n" "$*" > /tmp/orchard-bridge-args\nwhile :; do sleep 3600; done\n',
        '755'
      );
      vBox.sh('cd /opt/smoke-bridge && tar -czf orchard.tar.gz orchard && rm orchard');
      vSha = vBox.out('sha256sum /opt/smoke-bridge/orchard.tar.gz | cut -d" " -f1');
      vSession = new DockerVercelSession(vBox);
      const shaRef = { value: vSha as string | null };
      vRunner = vercelRunner(
        vSession,
        'file:///opt/smoke-bridge/orchard.tar.gz',
        () => shaRef.value
      );
      vRunner.shaRef = shaRef;
      process.stdout.write(`\n== vercel: ${opts.vercelImage} (pushInit) ==\n`);
      await vRunner.pushInit(vSession, { repoUrl: null }, vSecrets);
    }

    if (k8sBox && k8s) {
      const box = k8sBox;
      const kk = k8s;
      jobs.push(async () => {
        const secs = await waitReady(
          box,
          opts.bootTimeoutMs,
          () => docker(['logs', box.name]).stdout + docker(['logs', box.name]).stderr
        );
        record(
          'k8s',
          'first boot reached ready with sshd as PID 1',
          box.out('cat /proc/1/comm') === 'sshd',
          `${secs}s`
        );
        await bootChecks(box, {
          vercel: false,
          priv: keys.priv,
          identity: kk.secrets.gitIdentity!
        });
        if (opts.repoUrl) {
          await attempt('k8s', 'SANDBOX_REPO_URL cloned as dev', async () => {
            const dir = `${HOME_ROOT}/${opts.repoUrl
              .replace(/\.git$/, '')
              .split('/')
              .pop()}`;
            await waitFor(
              'clone',
              120_000,
              () => box.dev(`git -C ${dir} rev-parse HEAD`).code === 0,
              1000
            );
            eq(box.out(`stat -c %U ${dir}`), 'dev', 'owner');
          });
        }
        await rerunChecks(box, async () => {
          const t = Date.now();
          const r = box.sh('bash /orchard-init/bootstrap.sh 2>&1', { timeoutMs: 120_000 });
          return { code: r.code, seconds: Math.round((Date.now() - t) / 1000), log: r.stdout };
        });
        await sessionChecks({ box, runner: k8sRunner(box), sandbox: kk.row });
        if (opts.restart) {
          process.stdout.write(`\n== k8s: pod restart on the same volume ==\n`);
          const before = {
            fp: box.out('ssh-keygen -lf /persist/hostkeys/ssh_host_ed25519_key.pub'),
            uid: box.out('id -u dev')
          };
          docker(['rm', '-f', '-v', box.name]);
          created.containers.delete(box.name);
          const again = kk.start(`orchard-smoke-k8s2-${tag}`);
          const secs2 = await waitReady(
            again,
            opts.bootTimeoutMs,
            () => docker(['logs', again.name]).stderr
          );
          record('k8s', 'restarted pod reached ready', true, `${secs2}s`);
          await attempt(
            'k8s',
            'restart keeps host keys, uid, home, gitconfig, worktrees and skips setup',
            () => {
              eq(
                again.out('ssh-keygen -lf /persist/hostkeys/ssh_host_ed25519_key.pub'),
                before.fp,
                'host key'
              );
              eq(again.out('id -u dev'), before.uid, 'uid');
              eq(again.out('stat -c %U /persist/home /persist/home/app'), 'dev\ndev', 'owners');
              eq(again.out('cat /persist/home/setup-marker'), 'setup-ran', 'setup ran again');
              assert(
                again.ok("grep -q 'SMOKE_CUSTOM=kept' /persist/home/.bashrc"),
                '.bashrc reset'
              );
              eq(
                again.dev('git config --global user.email').stdout.trim(),
                'ada@example.com',
                'identity'
              );
              eq(
                again.dev(`git -C ${HOME_ROOT}/app worktree list | wc -l`).stdout.trim(),
                '2',
                'worktrees'
              );
              eq(again.dev('echo "$SMOKE_GREETING"').stdout.trim(), "it's alive", 'env');
            }
          );
        }
      });
    }

    if (vBox && vSession && vRunner) {
      const box = vBox;
      const session = vSession;
      const runner = vRunner;
      jobs.push(async () => {
        const secs = await waitReady(box, opts.bootTimeoutMs, () =>
          box.out('cat /tmp/smoke-cmd-*.log')
        );
        record('vercel', 'first boot reached ready with sshd running', true, `${secs}s`);
        await bootChecks(box, { vercel: true, priv: keys.priv, identity: vSecrets.gitIdentity! });
        await attempt('vercel', 'bridge installed from a verified tarball and started', () => {
          eq(box.out('stat -c %a /usr/local/bin/orchard'), '755', 'mode');
          eq(
            box.out('cat /usr/local/share/orchard/bridge-source'),
            `file:///opt/smoke-bridge/orchard.tar.gz ${vSha}`,
            'marker'
          );
          eq(
            box.out('cat /tmp/orchard-bridge-args'),
            'sandbox bridge --listen 0.0.0.0:2222 --target 127.0.0.1:22 --token-file /orchard-init/bridge-token',
            'args'
          );
        });
        const rerun = async (secrets: SandboxSecrets) => {
          const before = session.detached.length;
          const t = Date.now();
          await runner.pushInit(session, { repoUrl: null }, secrets);
          const tagN = session.detached[before];
          await waitFor(
            'rerun exit',
            120_000,
            () => box.ok(`[ -f /tmp/smoke-cmd-${tagN}.exit ]`),
            500
          );
          return {
            code: Number(box.out(`cat /tmp/smoke-cmd-${tagN}.exit`)),
            seconds: Math.round((Date.now() - t) / 1000),
            log: box.out(`cat /tmp/smoke-cmd-${tagN}.log`)
          };
        };
        const changed: SandboxSecrets = {
          ...vSecrets,
          attachedEnv: envBundle('b'),
          gitIdentity: { name: 'Ada King', email: 'ada.king@example.com' }
        };
        await rerunChecks(box, () => rerun(changed));
        await attempt(
          'vercel',
          'rerun syncs env files (prune + update) and the git identity',
          () => {
            eq(box.out('ls /persist/home/.config/orchard/env'), 'web-production.env', 'env files');
            eq(
              box.dev('echo "$SMOKE_GREETING|${SMOKE_API-unset}"').stdout.trim(),
              'second wind|unset',
              'env'
            );
            eq(
              box.dev('git config --global user.email').stdout.trim(),
              'ada.king@example.com',
              'identity'
            );
          }
        );
        box.dev('git config --global user.email me@custom.dev');
        runner.shaRef.value = '0'.repeat(64);
        const third = await rerun({
          ...changed,
          gitIdentity: { name: 'Ada C', email: 'ada.c@example.com' }
        });
        await attempt(
          'vercel',
          'rerun keeps a hand-set git email and rejects a checksum mismatch',
          () => {
            eq(third.code, 0, 'exit');
            eq(box.dev('git config --global user.email').stdout.trim(), 'me@custom.dev', 'email');
            assert(third.log.includes('did not match ORCHARD_BRIDGE_SHA256'), `log: ${third.log}`);
            eq(
              box.out('cat /usr/local/share/orchard/bridge-source'),
              `file:///opt/smoke-bridge/orchard.tar.gz ${vSha}`,
              'marker kept'
            );
          }
        );
        await sessionChecks({ box, runner, sandbox: vRow });
      });
    }

    for (const job of jobs) await job();
  } finally {
    cleanup(opts.keep);
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s\n`
  );
  for (const f of failed)
    process.stdout.write(`  FAIL [${f.suite}] ${f.name}: ${f.detail.split('\n')[0]}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  cleanup(false);
  process.exit(2);
});
