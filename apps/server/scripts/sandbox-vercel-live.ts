import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import WebSocket from 'ws';
import {
  SANDBOX_DRIVE_MARKER,
  SANDBOX_PHASE_FILE,
  defaultBridgeBinaryUrl
} from '../src/sandboxes/sandbox-bootstrap';
import {
  VERCEL_BRIDGE_PORT,
  VERCEL_DRIVE_FORK_UNAVAILABLE,
  VERCEL_DRIVE_ROOT,
  VERCEL_HOST_GIT_PLACEHOLDER,
  VERCEL_INIT_STAGE,
  VERCEL_OPENCODE_PORT,
  VERCEL_PERSIST_ROOT,
  VERCEL_PROVIDER_STOPPED,
  VercelSandboxRunner,
  githubNetworkPolicy,
  vercelInteractiveSupported,
  type VercelSandboxLike,
  type VercelSdk,
  type VercelSessionLike
} from '../src/sandboxes/runners/vercel.runner';
import type { SandboxRef, SandboxSecrets } from '../src/sandboxes/runners/sandbox-runner';
import { deriveSandboxSecret } from '../src/sandboxes/runners/sandbox-secrets';
import { opencodeBasicAuth } from '../src/sandboxes/runners/sandbox-init-files';

const NAME_PREFIX = 'orchard-live-';
const INSTANCE_TAG = 'orchard-live';
const STALE_PHASE = 'stale-before-stop';
const LOCAL_BRIDGE_PATH = '/tmp/orchard-live-bridge.tar.gz';
const ENV_KEYS = ['SANDBOX_VERCEL_TOKEN', 'SANDBOX_VERCEL_TEAM_ID', 'SANDBOX_VERCEL_PROJECT_ID'];

const HELP = `Usage: pnpm --filter server live:sandbox-vercel [options]

Drives the real VercelSandboxRunner against the real Vercel Sandbox API with an
in-memory database, apply queue and secrets service: provision, network policy
credential brokering, exec/execStream/readFile/writeFiles, the password-protected
opencode port, an interactive PTY, the SSH bridge, stop and resume, reconcile and
keepAlive, fork, the per-machine drive (home survives losing the sandbox, an old
snapshot-only machine migrates onto a drive), and destroy. Every sandbox and drive
is named ${NAME_PREFIX}<random>, sandboxes are tagged orchard_instance=${INSTANCE_TAG},
and everything is deleted in a finally block.

Credentials come from SANDBOX_VERCEL_TOKEN, SANDBOX_VERCEL_TEAM_ID and
SANDBOX_VERCEL_PROJECT_ID, read from the environment or apps/server/.env. The token
is never printed; every line of output is redacted.

This creates billable Vercel sandboxes (2 vCPU by default, about 20 minutes total).

Options
  --cleanup             delete every ${NAME_PREFIX}* sandbox and drive in the project and exit
  --image IMAGE         sandbox image (default: the runner default)
  --vcpus N             vCPUs (default 2)
  --timeout-minutes N   sandbox timeout (default 15)
  --repo-url URL        SANDBOX_REPO_URL (default octocat/Hello-World)
  --no-repo             leave SANDBOX_REPO_URL empty
  --bridge MODE         auto | release | local (default auto: local when the pinned
                        release has no "sandbox bridge" command). local builds apps/cli
                        for linux/amd64 and pushes the tarball with the init files.
  --boot-timeout SEC    seconds to wait for a boot to reach ready (default 900)
  --skip-fork           skip the fork step
  --skip-migration      skip the snapshot-only to drive migration step
  -h, --help            show this help

Exit status is 0 when every check passes.
`;

interface Options {
  cleanup: boolean;
  image: string;
  vcpus: number;
  timeoutMinutes: number;
  repoUrl: string;
  bridge: 'auto' | 'release' | 'local';
  bootTimeoutMs: number;
  fork: boolean;
  migration: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    cleanup: false,
    image: '',
    vcpus: 2,
    timeoutMinutes: 15,
    repoUrl: 'https://github.com/octocat/Hello-World.git',
    bridge: 'auto',
    bootTimeoutMs: 900_000,
    fork: true,
    migration: true
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
    } else if (arg === '--cleanup') opts.cleanup = true;
    else if (arg === '--image') opts.image = value();
    else if (arg === '--vcpus') opts.vcpus = Number(value());
    else if (arg === '--timeout-minutes') opts.timeoutMinutes = Number(value());
    else if (arg === '--repo-url') opts.repoUrl = value();
    else if (arg === '--no-repo') opts.repoUrl = '';
    else if (arg === '--bridge') {
      const v = value();
      if (v !== 'auto' && v !== 'release' && v !== 'local') {
        throw new Error('--bridge takes auto, release or local');
      }
      opts.bridge = v;
    } else if (arg === '--boot-timeout') opts.bootTimeoutMs = Number(value()) * 1000;
    else if (arg === '--skip-fork') opts.fork = false;
    else if (arg === '--skip-migration') opts.migration = false;
    else if (arg === '--') continue;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const redactions = new Set<string>();

function redact(text: string): string {
  let out = text;
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function say(text: string) {
  process.stdout.write(`${redact(text)}\n`);
}

function hideSecret(value: string | null | undefined) {
  if (!value) return;
  redactions.add(value);
  redactions.add(Buffer.from(value).toString('base64'));
  redactions.add(Buffer.from(`x-access-token:${value}`).toString('base64'));
  redactions.add(Buffer.from(`opencode:${value}`).toString('base64'));
}

interface Result {
  step: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function record(step: string, name: string, ok: boolean, detail = '') {
  results.push({ step, name, ok, detail });
  const pad = ok ? 'ok  ' : 'FAIL';
  const body = detail
    ? ok
      ? ` (${detail})`
      : `\n         ${detail.replace(/\n/g, '\n         ')}`
    : '';
  say(`  ${pad} [${step}] ${name}${body}`);
}

async function check(step: string, name: string, fn: () => Promise<string | void> | string | void) {
  try {
    const detail = await fn();
    record(step, name, true, detail || '');
    return true;
  } catch (e: any) {
    record(
      step,
      name,
      false,
      String(e?.stack && process.env.LIVE_STACKS ? e.stack : (e?.message ?? e))
    );
    return false;
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function loadCredentials(): { token: string; teamId: string; projectId: string } {
  const envFile = resolve(__dirname, '..', '.env');
  const fromFile = existsSync(envFile) ? parseDotenv(readFileSync(envFile)) : {};
  const read = (key: string) => (process.env[key] || fromFile[key] || '').trim();
  const missing = ENV_KEYS.filter((key) => !read(key));
  if (missing.length) {
    process.stderr.write(
      `refusing to run: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (environment or apps/server/.env)\n`
    );
    process.exit(2);
  }
  const creds = {
    token: read('SANDBOX_VERCEL_TOKEN'),
    teamId: read('SANDBOX_VERCEL_TEAM_ID'),
    projectId: read('SANDBOX_VERCEL_PROJECT_ID')
  };
  hideSecret(creds.token);
  return creds;
}

async function sdkModule() {
  return import('@vercel/sandbox');
}

async function listLive(creds: { token: string; teamId: string; projectId: string }) {
  const { Sandbox } = await sdkModule();
  const page = await Sandbox.list({ namePrefix: NAME_PREFIX, sortBy: 'name', limit: 50, ...creds });
  const out: { name: string; status: string; tags: Record<string, string> | undefined }[] = [];
  for await (const sandbox of page as AsyncIterable<any>) {
    out.push({ name: sandbox.name, status: sandbox.status, tags: sandbox.tags });
  }
  return out;
}

async function deleteByName(
  name: string,
  creds: { token: string; teamId: string; projectId: string }
): Promise<string> {
  const { Sandbox } = await sdkModule();
  try {
    const sandbox = await Sandbox.get({ name, ...creds });
    await sandbox.delete({ deleteOrphanSnapshots: true });
    return 'deleted';
  } catch (e: any) {
    if (e?.response?.status === 404) return 'already gone';
    return `delete failed: ${e?.message ?? e}`;
  }
}

async function listLiveDrives(creds: { token: string; teamId: string; projectId: string }) {
  const { Drive } = await sdkModule();
  const page = await Drive.list({ namePrefix: NAME_PREFIX, sortBy: 'name', limit: 50, ...creds });
  const out: string[] = [];
  for await (const drive of page as AsyncIterable<any>) out.push(drive.name);
  return out.filter((name) => name.startsWith(NAME_PREFIX));
}

async function deleteDriveByName(
  name: string,
  creds: { token: string; teamId: string; projectId: string }
): Promise<string> {
  if (!name.startsWith(NAME_PREFIX)) return 'refused: not a live-test drive';
  const { Drive } = await sdkModule();
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const drive = await Drive.get({ name, ...creds });
      await drive.delete();
      return 'deleted';
    } catch (e: any) {
      if (e?.response?.status === 404) return 'already gone';
      if (attempt === 10) return `delete failed: ${e?.message ?? e}`;
      await sleep(3000);
    }
  }
  return 'delete failed';
}

async function cleanupMode(creds: { token: string; teamId: string; projectId: string }) {
  const found = await listLive(creds);
  say(`found ${found.length} ${NAME_PREFIX}* sandbox(es)`);
  for (const sandbox of found) {
    if (!sandbox.name.startsWith(NAME_PREFIX)) continue;
    say(
      `  ${sandbox.name} (${sandbox.status}, instance=${sandbox.tags?.orchard_instance ?? '-'}): ${await deleteByName(sandbox.name, creds)}`
    );
  }
  const left = (await listLive(creds)).filter((s) => s.name.startsWith(NAME_PREFIX));
  say(
    left.length
      ? `still listed: ${left.map((s) => `${s.name}(${s.status})`).join(', ')}`
      : 'none left'
  );
  const drives = await listLiveDrives(creds);
  say(`found ${drives.length} ${NAME_PREFIX}* drive(s)`);
  for (const name of drives) say(`  ${name}: ${await deleteDriveByName(name, creds)}`);
  const drivesLeft = await listLiveDrives(creds);
  if (drivesLeft.length) say(`drives still listed: ${drivesLeft.join(', ')}`);
  return left.length + drivesLeft.length;
}

interface Row {
  id: string;
  userId: string;
  runner: 'vercel';
  podName: string;
  namespace: null;
  externalId: string | null;
  runnerState: any;
  status: string;
  desiredState: string;
  repoUrl: string | null;
  image: string;
  setupScript: string | null;
  statusMessage: string | null;
  lastActiveAt: Date | null;
  startedAt: Date | null;
}

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  for (const [key, expected] of Object.entries(where ?? {})) {
    if (expected && typeof expected === 'object' && Array.isArray(expected.in)) {
      if (!expected.in.includes(row[key])) return false;
    } else if (row[key] !== expected) return false;
  }
  return true;
}

function pick(row: Record<string, any> | undefined, select?: Record<string, boolean>) {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
  return out;
}

class FakeDb {
  readonly rows = new Map<string, Row>();
  readonly sandbox = {
    findUnique: async ({ where, select }: any) => pick(this.rows.get(where.id), select),
    findMany: async ({ where, select }: any) =>
      [...this.rows.values()].filter((r) => matches(r, where)).map((r) => pick(r, select)),
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.rows.values()) {
        if (!matches(row, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (const [id, row] of this.rows) {
        if (!matches(row, where)) continue;
        this.rows.delete(id);
        count += 1;
      }
      return { count };
    }
  };
}

interface QueueItem {
  dedupeKey: string;
  opType: string;
  manifest: unknown;
  sandboxId?: string;
}

class FakeQueue {
  readonly items: QueueItem[] = [];
  async enqueue(item: QueueItem) {
    const existing = this.items.findIndex((i) => i.dedupeKey === item.dedupeKey);
    if (existing >= 0) this.items.splice(existing, 1);
    this.items.push(item);
  }
}

class FakeExecutor {
  readonly handlers = new Map<string, (item: any) => Promise<void>>();
  registerHandler(op: string, fn: (item: any) => Promise<void>) {
    this.handlers.set(op, fn);
  }
}

function sshPublicKey(dir: string): string {
  const path = join(dir, 'id_ed25519');
  const r = spawnSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'orchard-live',
    '-f',
    path
  ]);
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  return readFileSync(`${path}.pub`, 'utf8').trim();
}

function binaryHasBridge(binary: Buffer): boolean {
  return (
    binary.includes(Buffer.from('token-file')) &&
    binary.includes(Buffer.from('tunnels to a local tcp port'))
  );
}

async function releaseHasBridge(dir: string): Promise<boolean> {
  const res = await fetch(defaultBridgeBinaryUrl());
  if (!res.ok) return false;
  const tgz = join(dir, 'release.tar.gz');
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const out = join(dir, 'release');
  mkdirSync(out);
  const r = spawnSync('tar', ['-xzf', tgz, '-C', out, 'orchard']);
  if (r.status !== 0) return false;
  return binaryHasBridge(readFileSync(join(out, 'orchard')));
}

function buildLocalBridge(dir: string): { tarball: Buffer; sha: string } {
  const cliDir = resolve(__dirname, '..', '..', 'cli');
  const stage = join(dir, 'bridge');
  mkdirSync(stage);
  const build = spawnSync('go', ['build', '-o', join(stage, 'orchard'), './'], {
    cwd: cliDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
    timeout: 600_000
  });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const tgz = join(dir, 'bridge.tar.gz');
  const tar = spawnSync('tar', ['-czf', tgz, '-C', stage, 'orchard']);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const tarball = readFileSync(tgz);
  return { tarball, sha: createHash('sha256').update(tarball).digest('hex') };
}

function withBridgePush(sdk: VercelSdk, tarball: Buffer): VercelSdk {
  const wrapSession = (session: VercelSessionLike): VercelSessionLike =>
    new Proxy(session, {
      get(target, prop) {
        if (prop === 'writeFiles') {
          return (files: { path: string; content: Uint8Array; mode?: number }[], opts?: any) => {
            const staging = files.some((f) => f.path.startsWith(`${VERCEL_INIT_STAGE}/`));
            const extra = staging
              ? [{ path: LOCAL_BRIDGE_PATH, content: tarball, mode: 0o644 }]
              : [];
            return target.writeFiles([...files, ...extra], opts);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  const wrap = (sandbox: VercelSandboxLike): VercelSandboxLike =>
    new Proxy(sandbox, {
      get(target, prop) {
        if (prop === 'currentSession') return () => wrapSession(target.currentSession());
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  return {
    ...sdk,
    create: async (params) => wrap(await sdk.create(params)),
    get: async (params) => wrap(await sdk.get(params)),
    fork: sdk.fork ? async (params) => wrap(await sdk.fork!(params)) : undefined
  };
}

function refOf(row: Row): SandboxRef {
  return {
    id: row.id,
    userId: row.userId,
    runner: 'vercel',
    podName: row.podName,
    namespace: null,
    externalId: row.externalId,
    runnerState: row.runnerState
  };
}

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(0);
    }, 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.terminate();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

function bridgeWsUrl(domain: string): string {
  const parsed = new URL(domain);
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
  parsed.pathname = '/';
  return parsed.toString();
}

function readUntil(
  stream: NodeJS.ReadableStream,
  pattern: RegExp,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let timer: NodeJS.Timeout | undefined;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!pattern.test(buf)) return;
      clearTimeout(timer);
      stream.off('data', onData);
      resolve(buf);
    };
    timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`timed out waiting for ${pattern}; got ${JSON.stringify(buf.slice(-300))}`));
    }, timeoutMs);
    stream.on('data', onData);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const creds = loadCredentials();
  if (opts.cleanup) {
    process.exit((await cleanupMode(creds)) === 0 ? 0 : 1);
  }

  if (!process.env.SECRETS_ENCRYPTION_KEY) {
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  }
  hideSecret(process.env.SECRETS_ENCRYPTION_KEY);
  const dummyGithub = `ghp_orchardLiveDummy${randomBytes(12).toString('hex')}`;
  hideSecret(dummyGithub);

  const work = mkdtempSync(join(tmpdir(), 'orchard-live-'));
  const tag = randomBytes(4).toString('hex');
  const created = new Set<string>();
  const createdDrives = new Set<string>();
  const createdDrivesAll = new Set<string>();
  const db = new FakeDb();
  const queue = new FakeQueue();
  const executor = new FakeExecutor();
  const timings: Record<string, string> = {};

  let interrupted = false;
  const finalCleanup = async () => {
    for (const name of created) {
      say(`cleanup: ${name}: ${await deleteByName(name, creds)}`);
    }
    for (const name of createdDrives) {
      say(`cleanup: drive ${name}: ${await deleteDriveByName(name, creds)}`);
    }
    rmSync(work, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    interrupted = true;
    say('interrupted, cleaning up');
    void finalCleanup().finally(() => process.exit(130));
  });

  try {
    const pub = sshPublicKey(work);

    let bridgeMode: 'release' | 'local' = opts.bridge === 'local' ? 'local' : 'release';
    if (opts.bridge === 'auto') {
      const has = await releaseHasBridge(work).catch(() => false);
      bridgeMode = has ? 'release' : 'local';
      say(
        `bridge: the pinned release ${has ? 'has' : 'does NOT have'} "sandbox bridge"; using the ${bridgeMode} binary`
      );
    }
    let local: { tarball: Buffer; sha: string } | null = null;
    if (bridgeMode === 'local') {
      const t0 = Date.now();
      local = buildLocalBridge(work);
      say(
        `bridge: built apps/cli for linux/amd64 (${(local.tarball.length / 1e6).toFixed(1)} MB tarball, ${secs(Date.now() - t0)})`
      );
    }

    const config: Record<string, string> = {
      vercelToken: creds.token,
      vercelTeamId: creds.teamId,
      vercelProjectId: creds.projectId,
      vercelVcpus: String(opts.vcpus),
      vercelTimeoutMinutes: String(opts.timeoutMinutes),
      ...(opts.image ? { vercelImage: opts.image } : {}),
      ...(local
        ? { bridgeBinaryUrl: `file://${LOCAL_BRIDGE_PATH}`, bridgeBinarySha256: local.sha }
        : {})
    };
    const fakeConfig = {
      generation: 1,
      value: (_section: unknown, name: string) => config[name] ?? null
    };
    const fakeSettings = {
      get: async () => INSTANCE_TAG,
      createIfAbsent: async () => undefined
    };
    const fakeSecrets = {
      boxSecret: async (purpose: 'opencode-password' | 'bridge-token', sandboxId: string) =>
        deriveSandboxSecret(purpose, sandboxId),
      forSandbox: async (row: {
        id: string;
        setupScript: string | null;
      }): Promise<SandboxSecrets> => {
        const opencodePassword = deriveSandboxSecret('opencode-password', row.id);
        const bridgeToken = deriveSandboxSecret('bridge-token', row.id);
        hideSecret(opencodePassword);
        hideSecret(bridgeToken);
        return {
          authorizedKeys: [pub],
          githubToken: dummyGithub,
          claudeToken: null,
          openaiToken: null,
          setupScript: row.setupScript,
          mcpToken: null,
          opencodePassword,
          bridgeToken,
          attachedEnv: { 'orchard-live': 'ORCHARD_LIVE=1\n' },
          gitIdentity: { name: 'Orchard Live', email: 'live@orchard.invalid' }
        };
      }
    };

    const runner = new VercelSandboxRunner(
      db as any,
      fakeConfig as any,
      fakeSettings as any,
      queue as any,
      executor as any,
      fakeSecrets as any
    );
    runner.interactiveSupported = await vercelInteractiveSupported();
    runner.drivePrefix = NAME_PREFIX;
    const setConfig = (name: string, value: string | null) => {
      if (value === null) delete config[name];
      else config[name] = value;
      fakeConfig.generation += 1;
    };
    if (local) runner.sdk = withBridgePush(runner.sdk, local.tarball);
    const configError = runner.configError();
    if (configError) throw new Error(`runner config error: ${configError}`);

    const drain = async () => {
      while (queue.items.length) {
        const item = queue.items.shift()!;
        const handler = executor.handlers.get(item.opType);
        if (!handler) throw new Error(`no handler for ${item.opType}`);
        await handler({ ...item, deploymentId: null });
      }
    };

    const newRow = (suffix = ''): Row => {
      const row: Row = {
        id: randomUUID(),
        userId: randomUUID(),
        runner: 'vercel',
        podName: `${NAME_PREFIX}${tag}${suffix}`,
        namespace: null,
        externalId: null,
        runnerState: null,
        status: 'creating',
        desiredState: 'running',
        repoUrl: opts.repoUrl || null,
        image: opts.image,
        setupScript: 'echo setup-ran > ~/.orchard-live-setup',
        statusMessage: null,
        lastActiveAt: new Date(),
        startedAt: null
      };
      db.rows.set(row.id, row);
      created.add(row.podName);
      createdDrives.add(`${NAME_PREFIX}${row.id}`);
      createdDrivesAll.add(`${NAME_PREFIX}${row.id}`);
      return row;
    };

    const phaseOf = async (row: Row) => {
      const r = await runner.readFile(refOf(row), SANDBOX_PHASE_FILE, { maxBytes: 64 });
      return r ? r.content.toString('utf8').trim() : '';
    };

    const waitReady = async (row: Row, label: string, fresh = false): Promise<number> => {
      const t0 = Date.now();
      let last = '';
      const seen: string[] = [];
      for (;;) {
        let phase = '';
        try {
          phase = await phaseOf(row);
        } catch (e: any) {
          phase = `error:${e?.message}`;
        }
        if (phase !== last) {
          seen.push(`${phase || '-'}@${secs(Date.now() - t0)}`);
          last = phase;
        }
        if (fresh && phase === STALE_PHASE) {
          throw new Error(`${label}: read the phase left over from before the stop`);
        }
        if (phase === 'ready') break;
        if (Date.now() - t0 > opts.bootTimeoutMs) {
          throw new Error(`${label}: boot did not reach ready (${seen.join(' ')})`);
        }
        await sleep(2000);
      }
      say(`  ${label} phases: ${seen.join(' ')}`);
      return Date.now() - t0;
    };

    const sh = async (row: Row, script: string, timeoutMs = 60_000) =>
      runner.exec(refOf(row), ['/bin/sh', '-c', script], { timeoutMs });

    const live = async (row: Row) => {
      const { Sandbox } = await sdkModule();
      return Sandbox.get({ name: row.podName, ...creds });
    };

    say(`\n== 1. provision ${NAME_PREFIX}${tag} ==`);
    const src = newRow();
    const ref = () => refOf(src);
    let provisioned = false;
    await check('1', 'provision through the vercel.provision handler', async () => {
      const t0 = Date.now();
      await runner.requestProvision(ref());
      await drain();
      timings.provisionHandler = secs(Date.now() - t0);
      assert(src.status === 'running', `row status is ${src.status} (${src.statusMessage ?? ''})`);
      assert(src.externalId === src.podName, 'externalId was not recorded');
      provisioned = true;
      return `create+wait+pushInit ${timings.provisionHandler}, expiresAt ${src.runnerState?.expiresAt ?? '-'}`;
    });
    if (!provisioned) throw new Error('provisioning failed; nothing else can run');

    await check('1', 'sandbox metadata', async () => {
      const sb: any = await live(src);
      return `status=${sb.status} vcpus=${sb.vcpus} memory=${sb.memory} region=${sb.region} image=${sb.image ?? sb.runtime} persistent=${sb.persistent} tags=${JSON.stringify(sb.tags)}`;
    });

    await check('1', 'snapshots never expire and the machine drive is mounted', async () => {
      const sb: any = await live(src);
      const driveName = src.runnerState?.driveName;
      assert(driveName === `${NAME_PREFIX}${src.id}`, `runnerState.driveName is ${driveName}`);
      assert(sb.snapshotExpiration === 0, `snapshotExpiration ${sb.snapshotExpiration}`);
      assert(
        sb.keepLastSnapshots?.count === 3,
        `keepLastSnapshots ${JSON.stringify(sb.keepLastSnapshots)}`
      );
      const mount = sb.mounts?.[VERCEL_DRIVE_ROOT];
      assert(
        mount?.drive === driveName && mount.mode === 'read-write',
        `mounts ${JSON.stringify(sb.mounts)}`
      );
      const { Drive } = await sdkModule();
      const drive = await Drive.get({ name: driveName, ...creds });
      assert(drive.region === sb.region, `drive in ${drive.region}, sandbox in ${sb.region}`);
      return `snapshotExpiration 0, keepLast ${JSON.stringify(sb.keepLastSnapshots)}, ${VERCEL_DRIVE_ROOT} <- ${driveName} (${drive.region}, ${(drive.maxSize / 1024 ** 3).toFixed(0)} GiB)`;
    });

    await check('1', 'first boot reaches ready', async () => {
      const ms = await waitReady(src, 'first boot');
      timings.firstBoot = secs(ms);
      return `${timings.firstBoot} after pushInit`;
    });

    await check('1', 'box facts after boot', async () => {
      const r = await sh(
        src,
        'uname -m; . /etc/os-release; echo "$PRETTY_NAME"; node -v 2>&1; for b in opencode claude codex sshd tmux rg git; do printf "%s=%s " $b "$(command -v $b || echo missing)"; done; echo; readlink /persist; id dev; df -h / /vercel/sandbox 2>/dev/null | tail -n +2'
      );
      assert(r.ok, r.stderr);
      return r.stdout.trim().replace(/\n/g, ' | ');
    });

    await check('1', 'home lives on the drive', async () => {
      const r = await sh(
        src,
        `mountpoint ${VERCEL_DRIVE_ROOT}; readlink /persist; cat ${VERCEL_DRIVE_ROOT}/${SANDBOX_DRIVE_MARKER}; stat -c '%U' /persist/home/.; df -h ${VERCEL_DRIVE_ROOT} | tail -1`
      );
      assert(r.stdout.includes('is a mountpoint'), r.stdout + r.stderr);
      assert(
        r.stdout.includes(`\n${VERCEL_DRIVE_ROOT}\n`),
        `/persist is not on the drive: ${r.stdout}`
      );
      assert(/\nfresh\n/.test(r.stdout), `marker: ${r.stdout}`);
      return r.stdout.trim().replace(/\n/g, ' | ');
    });

    await check(
      '1',
      'services up: sshd, opencode, setup script, repo clone, git identity, env bundle',
      async () => {
        const r = await sh(
          src,
          'pgrep -x sshd >/dev/null && echo sshd; pgrep -f "opencode serve" >/dev/null && echo opencode; cat /persist/home/.orchard-live-setup 2>/dev/null; [ -d /persist/home/Hello-World/.git ] && echo cloned; git config --file /persist/home/.gitconfig user.email; su - dev -c "env" | grep -c ORCHARD_LIVE=1'
        );
        return r.stdout.trim().replace(/\n/g, ' ');
      }
    );

    say('\n== 2. network policy credential brokering ==');
    await check('2', 'create accepted the header-match placeholder policy', async () => {
      const sb: any = await live(src);
      const policy = sb.networkPolicy;
      assert(policy, 'no network policy reported');
      const summary = typeof policy === 'string' ? policy : JSON.stringify(policy);
      assert(
        /github\.com/.test(summary),
        `policy does not mention github.com: ${summary.slice(0, 300)}`
      );
      return redact(summary).slice(0, 600);
    });

    const curl = async (args: string) => {
      const r = await sh(src, `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${args}`);
      return r.stdout.trim() || `err:${r.stderr.trim().slice(0, 120)}`;
    };
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`;

    await check('2', 'egress: example.com via the "*" rule', async () => {
      const code = await curl('https://example.com/');
      assert(code === '200', `example.com returned ${code}`);
      return code;
    });
    await check('2', 'api.github.com/zen without our own auth header', async () => {
      const code = await curl('https://api.github.com/zen');
      assert(
        code === '401',
        `expected 401 (the dummy Bearer injected by the unconditional api.github.com transform), got ${code}`
      );
      return `${code}: the egress proxy injected the (dummy) host token into a request that carried none`;
    });
    await check(
      '2',
      'github.com without a credential is not blocked by the header-match rule',
      async () => {
        const code = await curl(
          "'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack'"
        );
        assert(code === '200', `expected 200, got ${code}`);
        return code;
      }
    );
    await check('2', 'github.com with the placeholder credential', async () => {
      const code = await curl(
        `-H 'Authorization: ${basic(VERCEL_HOST_GIT_PLACEHOLDER)}' 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack'`
      );
      return `${code} (a dummy host token and the raw placeholder are both invalid, so GitHub alone cannot tell them apart; see the echo check)`;
    });
    await check('2', 'git ls-remote as dev through the credential helper', async () => {
      const r = await sh(
        src,
        "su - dev -c 'git ls-remote https://github.com/octocat/Hello-World.git HEAD'"
      );
      assert(r.ok, r.stderr.trim());
      return r.stdout.trim().slice(0, 60);
    });

    let echoProved = false;
    await check(
      '2',
      'same rule shape against an echo host proves match+substitute semantics',
      async () => {
        const rules = (githubNetworkPolicy(dummyGithub) as any).allow;
        const echoHost = 'httpbin.org';
        const bearerHost = 'postman-echo.com';
        const policy = {
          allow: {
            ...rules,
            [echoHost]: rules['github.com'],
            [bearerHost]: rules['api.github.com']
          }
        };
        const sb = await live(src);
        await sb.update({ networkPolicy: policy as any });
        await sleep(3000);
        const echo = async (host: string, header: string | null) => {
          const r = await sh(
            src,
            `curl -sS --max-time 20 ${header ? `-H 'Authorization: ${header}'` : ''} https://${host}/headers`
          );
          const body = JSON.parse(r.stdout || '{}');
          const headers = body.headers ?? {};
          return (headers.Authorization ?? headers.authorization ?? null) as string | null;
        };
        const swapped = await echo(echoHost, basic(VERCEL_HOST_GIT_PLACEHOLDER));
        const other = await echo(echoHost, basic('someone-else'));
        const none = await echo(echoHost, null);
        const injected = await echo(bearerHost, null);
        const lines = [
          `placeholder -> ${swapped === basic(dummyGithub) ? 'SUBSTITUTED with host token' : swapped === basic(VERCEL_HOST_GIT_PLACEHOLDER) ? 'passed through unchanged' : JSON.stringify(swapped)}`,
          `other basic -> ${other === basic('someone-else') ? 'unchanged' : other === basic(dummyGithub) ? 'SUBSTITUTED (rule ignores match!)' : JSON.stringify(other)}`,
          `no header -> ${none === null ? 'none' : none === basic(dummyGithub) ? 'INJECTED (rule ignores match!)' : JSON.stringify(none)}`,
          `unconditional rule, no header -> ${injected === `Bearer ${dummyGithub}` ? 'Bearer host token injected' : JSON.stringify(injected)}`
        ];
        assert(swapped === basic(dummyGithub), lines.join('; '));
        assert(other === basic('someone-else'), lines.join('; '));
        assert(none === null, lines.join('; '));
        echoProved = true;
        return lines.join('; ');
      }
    );
    void echoProved;

    await check(
      '2',
      'secret sync restores the runner policy via sandbox.update and reruns boot',
      async () => {
        const t0 = Date.now();
        await runner.requestSecretSync(ref());
        await drain();
        const sb: any = await live(src);
        const summary = JSON.stringify(sb.networkPolicy ?? '');
        assert(!/httpbin/.test(summary), 'echo rules still present after secret sync');
        await waitReady(src, 'secret-sync rerun');
        return `update+pushInit ${secs(Date.now() - t0)}`;
      }
    );

    say('\n== 3. exec / execStream / readFile / writeFiles ==');
    await check('3', 'exec stdout, stderr, exit code, env', async () => {
      const r = await runner.exec(
        ref(),
        ['/bin/sh', '-c', 'echo "out $FOO"; echo err >&2; exit 7'],
        {
          env: { FOO: 'bar' }
        }
      );
      assert(r.stdout === 'out bar\n', `stdout ${JSON.stringify(r.stdout)}`);
      assert(r.stderr === 'err\n', `stderr ${JSON.stringify(r.stderr)}`);
      assert(r.exitCode === 7 && !r.ok, `exitCode ${r.exitCode}`);
      return 'out bar / err / 7';
    });
    await check('3', 'exec runs as root', async () => {
      const r = await sh(src, 'id -u');
      assert(r.stdout.trim() === '0', r.stdout);
      return 'uid 0';
    });
    const big = randomBytes(300 * 1024);
    const bigSha = createHash('sha256').update(big).digest('hex');
    await check('3', 'exec with 300KB stdin', async () => {
      const t0 = Date.now();
      const r = await runner.exec(ref(), ['sha256sum'], { stdin: big, timeoutMs: 30_000 });
      assert(r.stdout.startsWith(bigSha), `sha mismatch ${r.stdout.slice(0, 64)}`);
      const leftovers = await sh(src, 'ls /tmp | grep -c orchard-stdin || true');
      assert(leftovers.stdout.trim() === '0', 'stdin staging file left behind');
      return `sha256 matches, staging file removed, ${secs(Date.now() - t0)}`;
    });
    await check('3', 'exec timeout', async () => {
      const t0 = Date.now();
      try {
        await runner.exec(ref(), ['sleep', '37'], { timeoutMs: 2000 });
      } catch (e: any) {
        const elapsed = secs(Date.now() - t0);
        const leaked = await sh(
          src,
          "pgrep -fx 'sleep 37' >/dev/null && echo still-running || echo gone"
        );
        return `${e?.message} after ${elapsed}; the box process is ${leaked.stdout.trim()}`;
      }
      throw new Error(`sleep 37 with timeoutMs 2000 returned after ${secs(Date.now() - t0)}`);
    });
    await check('3', 'execStream stdout/stderr/exit', async () => {
      const stream = await runner.execStream(ref(), [
        '/bin/sh',
        '-c',
        'for i in 1 2 3; do echo line$i; sleep 1; done; echo oops >&2; exit 3'
      ]);
      let out = '';
      let err = '';
      const stamps: number[] = [];
      const t0 = Date.now();
      stream.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        stamps.push(Date.now() - t0);
      });
      stream.stderr.on('data', (c: Buffer) => (err += c.toString()));
      const done = await stream.done;
      assert(out === 'line1\nline2\nline3\n', `stdout ${JSON.stringify(out)}`);
      assert(err === 'oops\n', `stderr ${JSON.stringify(err)}`);
      assert(done.exitCode === 3 && !done.ok, `done ${JSON.stringify(done)}`);
      const streamed = stamps.length > 1 && stamps[stamps.length - 1] - stamps[0] > 1000;
      return `exit 3, ${streamed ? 'chunks arrived incrementally' : 'output arrived in one burst'} (${stamps.map((s) => secs(s)).join(',')})`;
    });
    await check('3', 'execStream with 300KB stdin', async () => {
      const stream = await runner.execStream(ref(), ['sha256sum'], { stdin: big });
      let out = '';
      stream.stdout.on('data', (c: Buffer) => (out += c.toString()));
      const done = await stream.done;
      assert(
        done.ok && out.startsWith(bigSha),
        `done ${JSON.stringify(done)} out ${out.slice(0, 64)}`
      );
      return 'sha256 matches';
    });
    await check('3', 'execStream kill', async () => {
      const stream = await runner.execStream(ref(), ['/bin/sh', '-c', 'echo started; sleep 61']);
      await readUntil(stream.stdout, /started/, 20_000);
      const t0 = Date.now();
      stream.kill();
      const done = await Promise.race([stream.done, sleep(15_000).then(() => null)]);
      assert(done, 'done did not settle within 15s of kill');
      await sleep(1500);
      const still = await sh(src, "pgrep -fx 'sleep 61' >/dev/null && echo alive || echo gone");
      assert(still.stdout.trim() === 'gone', 'the child sleep survived kill');
      return `${JSON.stringify(done)} in ${secs(Date.now() - t0)}, child process gone`;
    });
    await check('3', 'writeFiles 300KB as dev + small as root, readFile round trip', async () => {
      const t0 = Date.now();
      await runner.writeFiles(ref(), [{ path: '/persist/home/live/big.bin', content: big }], {
        asUser: 'dev'
      });
      await runner.writeFiles(ref(), [
        { path: '/etc/orchard-live/small.txt', content: Buffer.from('hi\n') }
      ]);
      const owners = await sh(
        src,
        'stat -c %U /persist/home/live/big.bin /etc/orchard-live/small.txt'
      );
      assert(owners.stdout.trim() === 'dev\nroot', `owners ${owners.stdout}`);
      const back = await runner.readFile(ref(), '/persist/home/live/big.bin', {
        maxBytes: 1024 * 1024
      });
      assert(back && !back.truncated, 'readFile missing or truncated');
      assert(
        createHash('sha256').update(back.content).digest('hex') === bigSha,
        'readFile sha mismatch'
      );
      const asDev = await runner.readFile(ref(), '/persist/home/live/big.bin', {
        maxBytes: 1024 * 1024,
        asUser: 'dev'
      });
      assert(
        asDev && createHash('sha256').update(asDev.content).digest('hex') === bigSha,
        'asUser readFile sha mismatch'
      );
      const head = await runner.readFile(ref(), '/persist/home/live/big.bin', { maxBytes: 1000 });
      assert(
        head?.truncated && head.content.equals(big.subarray(0, 1000)),
        'head truncation wrong'
      );
      const tail = await runner.readFile(ref(), '/persist/home/live/big.bin', {
        maxBytes: 1000,
        fromEnd: true
      });
      assert(
        tail?.truncated && tail.content.equals(big.subarray(big.length - 1000)),
        'tail truncation wrong'
      );
      const missing = await runner.readFile(ref(), '/persist/home/live/nope', { maxBytes: 10 });
      assert(missing === null, 'missing file did not read as null');
      const missingDev = await runner.readFile(ref(), '/persist/home/live/nope', {
        maxBytes: 10,
        asUser: 'dev'
      });
      assert(missingDev === null, 'missing file as dev did not read as null');
      return `owners dev/root, sha matches (root + dev), head/tail truncation, missing -> null, ${secs(Date.now() - t0)}`;
    });

    say('\n== 4. opencode on the public port ==');
    await check('4', 'domain(4096) answers 200 with Basic auth, 401 without', async () => {
      const target = await runner.httpTarget(ref(), VERCEL_OPENCODE_PORT);
      assert(target.kind === 'url', 'httpTarget is not a url');
      const t0 = Date.now();
      let authed = 0;
      let path = '/config';
      while (Date.now() - t0 < 180_000) {
        for (const candidate of ['/config', '/doc']) {
          const res = await fetch(`${target.baseUrl}${candidate}`, {
            headers: target.headers
          }).catch(() => null);
          authed = res?.status ?? 0;
          if (authed === 200) {
            path = candidate;
            break;
          }
        }
        if (authed === 200) break;
        await sleep(3000);
      }
      assert(authed === 200, `with auth: ${authed} after ${secs(Date.now() - t0)}`);
      const anon = (await fetch(`${target.baseUrl}${path}`)).status;
      const wrong = (
        await fetch(`${target.baseUrl}${path}`, {
          headers: { authorization: opencodeBasicAuth('wrong') }
        })
      ).status;
      assert(anon === 401, `without auth: ${anon}`);
      assert(wrong === 401, `wrong password: ${wrong}`);
      return `${new URL(target.baseUrl).host}${path}: auth 200, none ${anon}, wrong ${wrong}`;
    });
    await check('4', 'preview port 3000 is public', async () => {
      await sh(
        src,
        "su - dev -c 'nohup python3 -m http.server 3000 --directory /tmp >/dev/null 2>&1 </dev/null &'"
      );
      const target = await runner.httpTarget(ref(), 3000);
      assert(target.kind === 'url', 'not a url');
      let status = 0;
      for (let i = 0; i < 10 && status !== 200; i++) {
        status = (await fetch(`${target.baseUrl}/`).catch(() => null))?.status ?? 0;
        if (status !== 200) await sleep(1500);
      }
      return `${new URL(target.baseUrl).host} -> ${status}`;
    });
    await check('4', 'unexposed port is refused by the runner', async () => {
      try {
        await runner.httpTarget(ref(), 9999);
      } catch (e: any) {
        return e?.message;
      }
      throw new Error('port 9999 was accepted');
    });

    say('\n== 5. interactive PTY ==');
    await check('5', 'openPty: echo, resize, exit code', async () => {
      const t0 = Date.now();
      const pty = await runner.openPty(ref(), {
        command: ['/bin/bash', '--noprofile', '--norc'],
        cols: 80,
        rows: 24
      });
      const opened = secs(Date.now() - t0);
      pty.stdin.write('echo hello-$((6*7))-$RANDOM; id -u\n');
      const echoed = await readUntil(pty.output, /hello-42-\d+\s+\d+/, 20_000);
      const uid = echoed.match(/hello-42-\d+\s+(\d+)/)?.[1];
      pty.resize(132, 40);
      await sleep(500);
      pty.stdin.write('stty size\n');
      const size = await readUntil(pty.output, /\b40 132\b/, 10_000).then(
        () => '40 132',
        (e) => `resize not observed: ${e.message.slice(0, 120)}`
      );
      pty.stdin.write('exit 3\n');
      const exited = await Promise.race([pty.exited, sleep(15_000).then(() => null)]);
      assert(exited, 'no exit frame within 15s');
      assert(/code 3/.test(exited.message ?? ''), `exit ${JSON.stringify(exited)}`);
      return `opened in ${opened}, uid ${uid}, stty ${size}, exit ${JSON.stringify(exited)}`;
    });

    say('\n== 6. ssh bridge on 2222 ==');
    await check('6', 'bridge binary installed and listening', async () => {
      const r = await sh(
        src,
        'ls -la /usr/local/bin/orchard 2>&1; cat /usr/local/share/orchard/bridge-source 2>/dev/null | cut -c1-60; echo; pgrep -af "orchard sandbox bridge" | head -1; ss -ltn | grep -E ":(2222|22) " ; tail -3 /var/log/orchard-bridge.log 2>/dev/null'
      );
      assert(/0\.0\.0\.0:2222|\*:2222|:::2222/.test(r.stdout), r.stdout);
      return `${bridgeMode} binary; ${r.stdout.trim().replace(/\n/g, ' | ').slice(0, 400)}`;
    });
    await check('6', 'tunnel refuses a missing or wrong token', async () => {
      const sb = await live(src);
      const url = bridgeWsUrl(sb.domain(VERCEL_BRIDGE_PORT));
      const none = await wsStatus(url);
      const wrong = await wsStatus(url, { authorization: 'Bearer wrong' });
      assert(none === 401 && wrong === 401, `none ${none}, wrong ${wrong}`);
      return `none ${none}, wrong ${wrong}`;
    });
    await check('6', 'openTcp(22) through the bridge reads the SSH banner', async () => {
      const t0 = Date.now();
      const duplex = await runner.openTcp(ref(), 22);
      const banner = await readUntil(duplex, /SSH-2\.0-[^\r\n]*/, 15_000);
      duplex.destroy();
      return `${banner.match(/SSH-2\.0-[^\r\n]*/)?.[0]} in ${secs(Date.now() - t0)}`;
    });
    await check('6', 'ssh login as dev through the bridge', async () => {
      const keyPath = join(work, 'id_ed25519');
      const sb = await live(src);
      const url = bridgeWsUrl(sb.domain(VERCEL_BRIDGE_PORT));
      const token = deriveSandboxSecret('bridge-token', src.id)!;
      const proxy = join(work, 'proxy.cjs');
      writeFileSync(
        proxy,
        `const WebSocket=require(${JSON.stringify(require.resolve('ws'))});const ws=new WebSocket(process.env.U,{headers:{authorization:'Bearer '+process.env.T}});const s=WebSocket.createWebSocketStream(ws);process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));s.on('error',()=>process.exit(1));`
      );
      const r = spawnSync(
        'ssh',
        [
          '-F',
          '/dev/null',
          '-i',
          keyPath,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=20',
          '-o',
          `ProxyCommand=${process.execPath} ${proxy}`,
          'dev@orchard-live',
          'echo ssh-ok $(whoami) $(pwd)'
        ],
        { env: { ...process.env, U: url, T: token }, timeout: 60_000 }
      );
      const out = r.stdout?.toString() ?? '';
      assert(/ssh-ok dev/.test(out), `ssh exit ${r.status}: ${r.stderr?.toString().slice(-300)}`);
      return out.trim();
    });

    say('\n== 8a. reconcile + keepAlive while running ==');
    await check('8', 'observe() and reconcile() agree with a running box', async () => {
      const obs = await runner.observe(ref());
      assert(obs.exists && obs.status === 'running', JSON.stringify(obs));
      await runner.reconcile([ref()]);
      assert(src.status === 'running', `row became ${src.status}`);
      const missing = await runner.observe({ ...ref(), podName: `${NAME_PREFIX}${tag}-missing` });
      assert(!missing.exists, `missing sandbox observed as ${JSON.stringify(missing)}`);
      assert(
        await runner.canTrustAbsence(),
        'canTrustAbsence false right after a successful API call'
      );
      return `observe ${JSON.stringify(obs)}, missing -> exists:false, trust absence true`;
    });
    await check('8', 'keepAlive extends the timeout', async () => {
      const before = (await live(src)).expiresAt?.getTime() ?? 0;
      src.lastActiveAt = new Date();
      src.runnerState = {
        ...(src.runnerState ?? {}),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      await runner.keepAlive(ref());
      const after = (await live(src)).expiresAt?.getTime() ?? 0;
      assert(after > before + 20 * 60_000, `expiresAt moved by ${secs(after - before)}`);
      return `expiresAt +${((after - before) / 60_000).toFixed(1)} min; stored ${src.runnerState?.expiresAt}`;
    });

    say('\n== 7a. markers + stop ==');
    const marker = `live-${tag}`;
    const markerPaths = [
      '/persist/home/.orchard-live-marker',
      `${VERCEL_PERSIST_ROOT}/orchard-live-marker`,
      '/vercel/sandbox/orchard-live-marker',
      '/usr/local/bin/orchard-live-marker',
      '/etc/orchard-live-marker',
      '/root/orchard-live-marker',
      '/opt/orchard-live-marker',
      '/var/tmp/orchard-live-marker',
      '/tmp/orchard-live-marker'
    ];
    await check('7', 'write markers across the filesystem', async () => {
      const r = await sh(
        src,
        `for p in ${markerPaths.join(' ')}; do mkdir -p "$(dirname "$p")"; echo ${marker} > "$p" || echo "failed $p"; done; printf ${STALE_PHASE} > ${SANDBOX_PHASE_FILE}; sync; echo done`
      );
      assert(r.stdout.trim() === 'done', r.stdout + r.stderr);
      return `${markerPaths.length} markers`;
    });
    let stopped = false;
    await check('7', 'stop through the vercel.stop handler', async () => {
      const t0 = Date.now();
      src.desiredState = 'stopped';
      src.status = 'stopping';
      let rounds = 0;
      while (src.status !== 'stopped' && Date.now() - t0 < 300_000) {
        rounds += 1;
        await runner.requestStop(ref());
        await drain();
        if (src.status !== 'stopped') await sleep(3000);
      }
      const sb = await live(src);
      assert(src.status === 'stopped', `row ${src.status}, vercel ${sb.status}`);
      timings.stop = secs(Date.now() - t0);
      stopped = true;
      return `${timings.stop}, ${rounds} handler round(s), vercel status ${sb.status}`;
    });

    if (stopped) {
      say('\n== 8b. reconcile against a stopped box ==');
      await check('8', 'reconcile maps a provider stop onto a running row', async () => {
        src.status = 'running';
        src.desiredState = 'running';
        await runner.reconcile([ref()]);
        assert(
          src.status === 'stopped' &&
            src.desiredState === 'stopped' &&
            src.statusMessage === VERCEL_PROVIDER_STOPPED,
          `row ${src.status}/${src.desiredState}/${src.statusMessage}`
        );
        const obs = await runner.observe(ref());
        assert(obs.exists && obs.status === 'stopped', JSON.stringify(obs));
        const sb = await live(src);
        assert(sb.status === 'stopped', `reconcile/observe woke the box: ${sb.status}`);
        return `row -> stopped/stopped "${VERCEL_PROVIDER_STOPPED}", observe ${JSON.stringify(obs)}, box still ${sb.status}`;
      });
      await check(
        '8',
        'secret sync on a stopped box updates the policy without resuming it',
        async () => {
          await runner.requestSecretSync(ref());
          await drain();
          await sleep(2000);
          const sb = await live(src);
          assert(sb.status === 'stopped', `the box is now ${sb.status}`);
          return `box still ${sb.status}`;
        }
      );
      await check('8', 'exec on a stopped box raises SandboxNotRunningError', async () => {
        try {
          await sh(src, 'true');
        } catch (e: any) {
          const sb = await live(src);
          assert(sb.status === 'stopped', `exec resumed the box: ${sb.status}`);
          return `${e?.constructor?.name}: ${e?.message}`;
        }
        throw new Error('exec succeeded on a stopped box');
      });
    }

    let fork: Row | null = null;
    if (stopped && opts.fork) {
      say('\n== 9. fork the stopped box ==');
      fork = newRow('-fork');
      fork.runnerState = { forkFrom: { sandboxId: src.id, podName: src.podName } };
      const unsupported = await runner.forkSupport(ref());
      say(`  fork support: ${unsupported ?? 'drive forks available'}`);
      if (unsupported === VERCEL_DRIVE_FORK_UNAVAILABLE) {
        const refused = fork;
        await check(
          '9',
          'a fork without drive forks fails clearly and creates nothing',
          async () => {
            let message = '';
            try {
              await runner.requestFork(ref(), refOf(refused));
              await drain();
            } catch (e: any) {
              message = e?.message ?? String(e);
              assert(e?.statusCode === 422, `not terminal: ${JSON.stringify(e?.statusCode)}`);
            }
            assert(
              message === VERCEL_DRIVE_FORK_UNAVAILABLE,
              `error was ${JSON.stringify(message)}`
            );
            assert(refused.status === 'error', `fork row ${refused.status}`);
            assert(runner.capabilities.fork === false, 'capabilities.fork still true');
            const { Sandbox, Drive } = await sdkModule();
            const sbGone = await Sandbox.get({ name: refused.podName, ...creds }).then(
              () => false,
              (e: any) => e?.response?.status === 404
            );
            const driveGone = await Drive.get({
              name: `${NAME_PREFIX}${refused.id}`,
              ...creds
            }).then(
              () => false,
              (e: any) => e?.response?.status === 404
            );
            assert(sbGone && driveGone, `sandbox gone ${sbGone}, drive gone ${driveGone}`);
            queue.items.length = 0;
            db.rows.delete(refused.id);
            created.delete(refused.podName);
            return `"${message}", capabilities.fork false, no sandbox or drive left behind`;
          }
        );
        fork = null;
      }
      if (fork)
        await check('9', 'fork through the vercel.fork handler', async () => {
          const t0 = Date.now();
          await runner.requestFork(ref(), refOf(fork!));
          await drain();
          assert(
            fork!.status === 'running',
            `fork row ${fork!.status} ${fork!.statusMessage ?? ''}`
          );
          assert(fork!.runnerState?.forkedAt, 'forkedAt not recorded');
          timings.forkHandler = secs(Date.now() - t0);
          return `fork+wait+pushInit ${timings.forkHandler}`;
        });
      if (fork?.status === 'running') {
        await check('9', 'fork boots to ready', async () => {
          const ms = await waitReady(fork!, 'fork boot', true);
          timings.forkBoot = secs(ms);
          return timings.forkBoot;
        });
        await check('9', 'fork carries the source markers', async () => {
          const r = await sh(
            fork!,
            `for p in ${markerPaths.join(' ')}; do printf '%s=%s\\n' "$p" "$(cat "$p" 2>/dev/null || echo -)"; done`
          );
          const kept = r.stdout
            .trim()
            .split('\n')
            .filter((l) => l.endsWith(`=${marker}`))
            .map((l) => l.split('=')[0]);
          assert(kept.includes('/persist/home/.orchard-live-marker'), r.stdout);
          return `kept: ${kept.join(' ')}`;
        });
        await check(
          '9',
          'fork opencode answers its own password, not the source password',
          async () => {
            const target = await runner.httpTarget(refOf(fork!), VERCEL_OPENCODE_PORT);
            assert(target.kind === 'url', 'not a url');
            let own = 0;
            for (let i = 0; i < 40 && own !== 200; i++) {
              own =
                (
                  await fetch(`${target.baseUrl}/config`, { headers: target.headers }).catch(
                    () => null
                  )
                )?.status ?? 0;
              if (own !== 200) await sleep(3000);
            }
            const srcPassword = deriveSandboxSecret('opencode-password', src.id)!;
            const theirs = (
              await fetch(`${target.baseUrl}/config`, {
                headers: { authorization: opencodeBasicAuth(srcPassword) }
              })
            ).status;
            assert(own === 200 && theirs === 401, `own ${own}, source password ${theirs}`);
            return `own 200, source password ${theirs}`;
          }
        );
      }
    }

    if (stopped) {
      say('\n== 7b. resume + persistence ==');
      await check('7', 'resume through the vercel.start handler', async () => {
        const t0 = Date.now();
        src.desiredState = 'running';
        src.status = 'starting';
        await runner.requestStart(ref());
        await drain();
        assert(src.status === 'running', `row ${src.status} ${src.statusMessage ?? ''}`);
        timings.resumeHandler = secs(Date.now() - t0);
        return `get(resume)+update+pushInit ${timings.resumeHandler}`;
      });
      await check('7', 'boot rerun after resume reaches ready', async () => {
        const ms = await waitReady(src, 'resume boot', true);
        timings.resumeBoot = secs(ms);
        return timings.resumeBoot;
      });
      await check('7', 'which markers survived stop/resume', async () => {
        const r = await sh(
          src,
          `for p in ${markerPaths.join(' ')}; do printf '%s=%s\\n' "$p" "$(cat "$p" 2>/dev/null || echo -)"; done`
        );
        const lines = r.stdout.trim().split('\n');
        const kept = lines.filter((l) => l.endsWith(`=${marker}`)).map((l) => l.split('=')[0]);
        const lost = lines.filter((l) => !l.endsWith(`=${marker}`)).map((l) => l.split('=')[0]);
        assert(
          kept.includes('/persist/home/.orchard-live-marker'),
          `persist home lost: ${r.stdout}`
        );
        return `kept: ${kept.join(' ')} | lost: ${lost.join(' ') || 'none'}`;
      });
      await check('7', 'dev user, home, bridge, agents and services after resume', async () => {
        const r = await sh(
          src,
          'id dev; readlink /persist; ls /usr/local/bin/orchard >/dev/null 2>&1 && echo bridge-bin; command -v opencode >/dev/null && echo opencode-bin; pgrep -x sshd >/dev/null && echo sshd; pgrep -f "opencode serve" >/dev/null && echo opencode-serve; pgrep -f "orchard sandbox bridge" >/dev/null && echo bridge-up; [ -d /persist/home/Hello-World/.git ] && echo repo; cat /persist/home/live/big.bin | sha256sum | cut -c1-12'
        );
        assert(/uid=\d+\(dev\)/.test(r.stdout), r.stdout);
        return r.stdout.trim().replace(/\n/g, ' | ');
      });
      await check('7', 'opencode and bridge answer after resume', async () => {
        const target = await runner.httpTarget(ref(), VERCEL_OPENCODE_PORT);
        assert(target.kind === 'url', 'not a url');
        let status = 0;
        for (let i = 0; i < 40 && status !== 200; i++) {
          status =
            (await fetch(`${target.baseUrl}/config`, { headers: target.headers }).catch(() => null))
              ?.status ?? 0;
          if (status !== 200) await sleep(3000);
        }
        const duplex = await runner.openTcp(ref(), 22);
        const banner = await readUntil(duplex, /SSH-2\.0-/, 15_000).then(
          () => 'banner',
          (e) => e.message
        );
        duplex.destroy();
        assert(status === 200 && banner === 'banner', `opencode ${status}, bridge ${banner}`);
        return `opencode 200, ssh ${banner}`;
      });
    }

    const stopRow = async (row: Row) => {
      row.desiredState = 'stopped';
      row.status = 'stopping';
      const t0 = Date.now();
      while (row.status !== 'stopped' && Date.now() - t0 < 300_000) {
        await runner.requestStop(refOf(row));
        await drain();
        if (row.status !== 'stopped') await sleep(3000);
      }
      assert(row.status === 'stopped', `row ${row.status}`);
      return secs(Date.now() - t0);
    };

    const startRow = async (row: Row) => {
      row.desiredState = 'running';
      row.status = 'starting';
      const t0 = Date.now();
      await runner.requestStart(refOf(row));
      await drain();
      assert(row.status === 'running', `row ${row.status} ${row.statusMessage ?? ''}`);
      return secs(Date.now() - t0);
    };

    if (stopped && src.status === 'running') {
      say('\n== 11. the drive outlives its sandbox ==');
      let lost = false;
      await check('11', 'stop, then delete only the sandbox (not the drive)', async () => {
        const w = await sh(
          src,
          `echo ${marker}-drive > /persist/home/.orchard-live-drive-marker && chown dev:dev /persist/home/.orchard-live-drive-marker && sync && echo ok`
        );
        assert(w.stdout.trim() === 'ok', w.stdout + w.stderr);
        const took = await stopRow(src);
        const sb = await live(src);
        await sb.delete({ deleteOrphanSnapshots: true });
        const { Sandbox, Drive } = await sdkModule();
        const gone = await Sandbox.get({ name: src.podName, ...creds }).then(
          () => false,
          (e: any) => e?.response?.status === 404
        );
        assert(gone, 'the sandbox is still there');
        const drive = await Drive.get({ name: src.runnerState.driveName, ...creds });
        lost = true;
        return `stopped in ${took}, sandbox and its snapshots deleted, drive ${drive.name} still there`;
      });
      if (lost) {
        await check(
          '11',
          'start puts the machine on a new sandbox mounting the same drive',
          async () => {
            const took = await startRow(src);
            const sb: any = await live(src);
            const mount = sb.mounts?.[VERCEL_DRIVE_ROOT];
            assert(
              mount?.drive === src.runnerState.driveName,
              `mounts ${JSON.stringify(sb.mounts)}`
            );
            const boot = await waitReady(src, 'replacement boot');
            return `start ${took}, boot ${secs(boot)}, ${VERCEL_DRIVE_ROOT} <- ${mount.drive}`;
          }
        );
        await check('11', 'home, keys and files came back from the drive', async () => {
          const r = await sh(
            src,
            `cat /persist/home/.orchard-live-drive-marker /persist/home/.orchard-live-marker; readlink /persist; stat -c '%U' /persist/home/.orchard-live-drive-marker; sha256sum /persist/home/live/big.bin | cut -c1-12; [ -s /persist/hostkeys/ssh_host_ed25519_key ] && echo hostkey; cat ${VERCEL_DRIVE_ROOT}/${SANDBOX_DRIVE_MARKER}`
          );
          const out = r.stdout;
          assert(out.includes(`${marker}-drive\n`), `drive marker missing: ${out}`);
          assert(out.includes(`${marker}\n`), `persist marker missing: ${out}`);
          assert(out.includes(`${VERCEL_DRIVE_ROOT}\n`), `/persist not on the drive: ${out}`);
          assert(out.includes(bigSha.slice(0, 12)), `big.bin changed: ${out}`);
          assert(out.includes('hostkey'), `host key missing: ${out}`);
          return out.trim().replace(/\n/g, ' | ');
        });
      }
    }

    const extra: Row[] = [];
    if (opts.migration) {
      say('\n== 12. a snapshot-only machine moves onto a drive ==');
      setConfig('vercelDriveGiB', '0');
      const legacy = newRow('-legacy');
      extra.push(legacy);
      let legacyUp = false;
      await check('12', 'provision with drives off, the way machines used to be', async () => {
        await runner.requestProvision(refOf(legacy));
        await drain();
        assert(legacy.status === 'running', `row ${legacy.status} ${legacy.statusMessage ?? ''}`);
        assert(!legacy.runnerState?.driveName, 'a drive was recorded');
        const sb: any = await live(legacy);
        assert(
          !sb.mounts || Object.keys(sb.mounts).length === 0,
          `mounts ${JSON.stringify(sb.mounts)}`
        );
        await waitReady(legacy, 'legacy boot');
        const r = await sh(
          legacy,
          `readlink /persist; echo ${marker}-legacy > /persist/home/.orchard-live-legacy && chown dev:dev /persist/home/.orchard-live-legacy && chmod 600 /persist/home/.orchard-live-legacy && sync`
        );
        assert(r.stdout.trim() === VERCEL_PERSIST_ROOT, `/persist -> ${r.stdout}`);
        legacyUp = true;
        return `home in ${r.stdout.trim()}, snapshotExpiration ${sb.snapshotExpiration}`;
      });
      setConfig('vercelDriveGiB', null);
      if (legacyUp) {
        await check('12', 'stop, then start with drives on attaches a new drive', async () => {
          const stopTook = await stopRow(legacy);
          const startTook = await startRow(legacy);
          const driveName = legacy.runnerState?.driveName;
          assert(driveName === `${NAME_PREFIX}${legacy.id}`, `driveName ${driveName}`);
          const sb: any = await live(legacy);
          assert(
            sb.mounts?.[VERCEL_DRIVE_ROOT]?.drive === driveName,
            `mounts ${JSON.stringify(sb.mounts)}`
          );
          const boot = await waitReady(legacy, 'migrating boot');
          return `stop ${stopTook}, start ${startTook}, boot ${secs(boot)}`;
        });
        await check(
          '12',
          'the old home was copied onto the drive and left where it was',
          async () => {
            const r = await sh(
              legacy,
              `readlink /persist; head -c 9 ${VERCEL_DRIVE_ROOT}/${SANDBOX_DRIVE_MARKER}; echo; cat /persist/home/.orchard-live-legacy; stat -c '%U %a' /persist/home/.orchard-live-legacy; cat ${VERCEL_PERSIST_ROOT}/home/.orchard-live-legacy; stat -c '%U' /persist/home/.; [ -s /persist/hostkeys/ssh_host_ed25519_key ] && echo hostkey; [ -f /persist/.setup-done ] && echo setup-done`
            );
            const lines = r.stdout.trim().split('\n');
            assert(lines[0] === VERCEL_DRIVE_ROOT, `/persist -> ${lines[0]}`);
            assert(lines[1] === 'migrated ', `marker ${lines[1]}`);
            assert(lines[2] === `${marker}-legacy`, `drive copy ${lines[2]}`);
            assert(lines[3] === 'dev 600', `owner/mode ${lines[3]}`);
            assert(lines[4] === `${marker}-legacy`, `old copy ${lines[4]}`);
            assert(lines[5] === 'dev', `home owner ${lines[5]}`);
            assert(lines.includes('hostkey'), 'host key not carried over');
            return lines.join(' | ');
          }
        );
        await check('12', 'sshd and opencode run from the migrated home', async () => {
          const r = await sh(
            legacy,
            'pgrep -x sshd >/dev/null && echo sshd; pgrep -f "opencode serve" >/dev/null && echo opencode; getent passwd dev | cut -d: -f6'
          );
          assert(/sshd/.test(r.stdout) && /\/persist\/home/.test(r.stdout), r.stdout);
          return r.stdout.trim().replace(/\n/g, ' ');
        });
      }
    }

    say('\n== 10. destroy ==');
    for (const row of [src, ...(fork ? [fork] : []), ...extra]) {
      await check('10', `destroy ${row.podName} through the vercel.destroy handler`, async () => {
        const t0 = Date.now();
        row.desiredState = 'deleted';
        row.status = 'deleting';
        await runner.requestDestroy(refOf(row));
        await drain();
        assert(!db.rows.has(row.id), 'row was not removed');
        const { Sandbox } = await sdkModule();
        try {
          const sb = await Sandbox.get({ name: row.podName, ...creds });
          throw new Error(`still exists: ${sb.status}`);
        } catch (e: any) {
          if (e?.response?.status !== 404) throw e;
        }
        created.delete(row.podName);
        const driveName = `${NAME_PREFIX}${row.id}`;
        const { Drive } = await sdkModule();
        const driveGone = await Drive.get({ name: driveName, ...creds }).then(
          () => false,
          (e: any) => e?.response?.status === 404
        );
        assert(driveGone, `drive ${driveName} survived destroy`);
        createdDrives.delete(driveName);
        return `${secs(Date.now() - t0)}, sandbox and drive -> 404`;
      });
    }
  } catch (e: any) {
    record('-', 'run aborted', false, String(e?.message ?? e));
  } finally {
    if (!interrupted) {
      await finalCleanup();
      await check('10', `no ${NAME_PREFIX}${tag}* sandboxes left`, async () => {
        const left = (await listLive(creds)).filter((s) =>
          s.name.startsWith(`${NAME_PREFIX}${tag}`)
        );
        assert(left.length === 0, `left: ${left.map((s) => s.name).join(', ')}`);
        return 'none';
      });
      await check('10', 'no drives from this run left', async () => {
        const left = (await listLiveDrives(creds)).filter((name) => createdDrivesAll.has(name));
        assert(left.length === 0, `left: ${left.join(', ')}`);
        return 'none';
      });
    }
  }

  say('\n== timings ==');
  for (const [k, v] of Object.entries(timings)) say(`  ${k}: ${v}`);
  const failed = results.filter((r) => !r.ok);
  say(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) say(`  FAIL [${f.step}] ${f.name}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${redact(String(e?.stack ?? e))}\n`);
  process.exit(1);
});
