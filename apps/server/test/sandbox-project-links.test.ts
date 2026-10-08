import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import {
  ORCHARD_ENV_INIT_FILE,
  ORCHARD_ENV_PROFILE,
  ORCHARD_ENV_SYNC_SCRIPT,
  orchardEnvBundle,
  parseOrchardEnvBundle,
  renderEnvFile,
  shellEnvValue
} from '../src/sandboxes/links/sandbox-env-files';
import {
  previewEnvSlug,
  previewStatusOf,
  previewUrlOf
} from '../src/sandboxes/links/preview-state';
import {
  SandboxProjectEnvService,
  publicDatabaseUrl
} from '../src/sandboxes/links/sandbox-project-env.service';
import { SandboxProjectLinksService } from '../src/sandboxes/links/sandbox-project-links.service';
import {
  SandboxPreviewDeployService,
  cloneEnv,
  parsePushedHead
} from '../src/sandboxes/links/sandbox-preview-deploy.service';
import { SandboxLinksController } from '../src/sandboxes/links/sandbox-links.controller';
import {
  KubernetesSandboxRunner,
  SANDBOX_OP_SECRET
} from '../src/sandboxes/runners/kubernetes.runner';
import { stagedInitFiles, SECRET_INIT_FILES } from '../src/sandboxes/runners/sandbox-init-files';
import { SANDBOX_BOOTSTRAP_SCRIPT } from '../src/sandboxes/sandbox-bootstrap';
import { SandboxSessionsService } from '../src/sandboxes/sandbox-sessions.service';
import { onEnvironmentEnvChanged, signalEnvironmentEnvChanged } from '../src/env/env-change-signal';

const SANDBOX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const ENV = '66666666-6666-4666-8666-666666666666';
const SOURCE = '77777777-7777-4777-8777-777777777777';
const SHA = 'a'.repeat(40);

function sourceIn(sh: string, file: string, keys: string[]): string[] {
  const script = `set -a; . "$1"; set +a; shift; for k in "$@"; do eval "printf '%s\\0' \\"\\$$k\\""; done`;
  const out = execFileSync(sh, ['-c', script, sh, file, ...keys]).toString('utf8');
  return out.split('\0').slice(0, keys.length);
}

test('env files are shell-quoted so sourcing them yields the exact values', () => {
  const tricky = {
    QUOTE: "it's 'quoted'",
    DOLLAR: '$HOME and `whoami` and $(id)',
    NEWLINE: 'line one\nline two',
    BACKSLASH: 'C:\\path\\n',
    SPACES: '  padded  ',
    EMPTY: ''
  };
  const file = renderEnvFile({
    projectName: 'Web\nApp',
    environmentName: 'Production',
    vars: Object.entries(tricky).map(([key, value]) => ({ key, value }))
  });
  assert.ok(!file.split('\n')[0].includes('\nApp'));
  const dir = mkdtempSync(join(tmpdir(), 'orchard-env-'));
  const path = join(dir, 'web.env');
  writeFileSync(path, file);
  for (const sh of ['sh', 'bash']) {
    const values = sourceIn(sh, path, Object.keys(tricky));
    assert.deepEqual(values, Object.values(tricky), sh);
  }
  assert.equal(shellEnvValue("a'b"), `'a'\\''b'`);
});

test('secret shared vars and anything built from them stay write-only', () => {
  const file = renderEnvFile({
    projectName: 'api',
    environmentName: 'prod',
    vars: [
      { key: 'API_KEY', value: '', secret: true },
      { key: 'AUTH_HEADER', value: 'Bearer ${{shared.API_KEY}}' },
      { key: 'PUBLIC_URL', value: 'https://${{shared.HOST}}' },
      { key: 'HOST', value: 'api.example.com' },
      { key: 'PATH', value: '/evil' }
    ]
  });
  assert.match(file, /^# API_KEY is secret/m);
  assert.match(file, /^# AUTH_HEADER is secret/m);
  assert.match(file, /^PUBLIC_URL='https:\/\/api\.example\.com'$/m);
  assert.match(file, /^# PATH is skipped/m);
  assert.ok(!/^PATH=/m.test(file));
  assert.ok(!file.includes('Bearer'));
});

test('DATABASE_URL comes from the database only when shared vars do not set one', () => {
  const withDb = renderEnvFile({
    projectName: 'p',
    environmentName: 'e',
    vars: [],
    database: { name: 'main', url: 'postgresql://u:p@h:5432/d' }
  });
  assert.match(withDb, /^DATABASE_URL='postgresql:\/\/u:p@h:5432\/d'$/m);
  const privateDb = renderEnvFile({
    projectName: 'p',
    environmentName: 'e',
    vars: [],
    database: { name: 'main', url: null }
  });
  assert.match(privateDb, /^# DATABASE_URL is unset: turn on public access for main/m);
  const overridden = renderEnvFile({
    projectName: 'p',
    environmentName: 'e',
    vars: [{ key: 'DATABASE_URL', value: 'postgres://external' }],
    database: { name: 'main', url: 'postgresql://u:p@h:5432/d' }
  });
  assert.equal(overridden.match(/DATABASE_URL=/g)?.length, 1);
  assert.match(overridden, /postgres:\/\/external/);
  assert.equal(
    publicDatabaseUrl(
      {
        name: 'main',
        dbName: 'app',
        dbUser: 'app',
        dbPassword: 'x',
        mode: 'cnpg',
        namespace: 'ns',
        clusterName: 'c',
        publicEnabled: true,
        publicIp: '1.2.3.4',
        publicPort: 31000
      },
      'pw',
      'ns-c.db.example.com'
    ),
    'postgresql://app:pw@ns-c.db.example.com:31000/app?sslmode=verify-full&sslrootcert=system'
  );
});

test('the env bundle round-trips and drops names that are not safe file names', () => {
  const bundle = orchardEnvBundle({
    web: 'A=1\n',
    'api-2': "B='x y'\n",
    '../evil': 'C=1\n',
    Upper: 'D=1\n'
  });
  assert.deepEqual(parseOrchardEnvBundle(bundle), { 'api-2': "B='x y'\n", web: 'A=1\n' });
  assert.ok(bundle.endsWith('\n'));
  assert.equal(orchardEnvBundle(undefined), '');
});

test('the in-box sync script, the profile hook and the bootstrap parse as shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-env-sh-'));
  for (const [name, body] of Object.entries({
    'sync.sh': ORCHARD_ENV_SYNC_SCRIPT,
    'profile.sh': ORCHARD_ENV_PROFILE,
    'bootstrap.sh': SANDBOX_BOOTSTRAP_SCRIPT
  })) {
    const path = join(dir, name);
    writeFileSync(path, body);
    execFileSync('bash', ['-n', path]);
    if (name !== 'bootstrap.sh') execFileSync('sh', ['-n', path]);
  }
  assert.ok(SANDBOX_BOOTSTRAP_SCRIPT.includes('orchard_env_sync < /orchard-init/orchard-env'));
  assert.ok(SANDBOX_BOOTSTRAP_SCRIPT.includes('/etc/profile.d/orchard-env.sh'));
  assert.ok(SECRET_INIT_FILES.includes(ORCHARD_ENV_INIT_FILE));
});

test('the in-box sync writes 0600 files from the bundle and prunes detached ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchard-persist-'));
  const user = execFileSync('id', ['-un']).toString().trim();
  const group = execFileSync('id', ['-gn']).toString().trim();
  const script = ORCHARD_ENV_SYNC_SCRIPT.replaceAll('/persist/home', `${root}/home`)
    .replace('id dev', `id ${user}`)
    .replace('dev:dev', `${user}:${group}`)
    .replace('-o dev -g dev', `-o ${user} -g ${group}`);
  const dir = join(root, 'home/.config/orchard/env');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'old.env'), 'OLD=1\n');
  writeFileSync(join(dir, 'notes.txt'), 'kept');
  const bundle = orchardEnvBundle({ web: "A='1'\n", api: "B='two words'\n" }) + '../x Zm9v\n';
  execFileSync('sh', ['-c', script], { input: bundle });
  const listing = execFileSync('ls', [dir]).toString().trim().split('\n').sort();
  assert.deepEqual(listing, ['api.env', 'notes.txt', 'web.env']);
  const mode = execFileSync(
    'stat',
    process.platform === 'darwin'
      ? ['-f', '%Lp', join(dir, 'web.env')]
      : ['-c', '%a', join(dir, 'web.env')]
  )
    .toString()
    .trim();
  assert.equal(mode, '600');
  assert.equal(execFileSync('cat', [join(dir, 'api.env')]).toString(), "B='two words'\n");
  execFileSync('sh', ['-c', script], { input: '' });
  assert.deepEqual(execFileSync('ls', [dir]).toString().trim().split('\n'), ['notes.txt']);
});

test('the profile hook exports every env file into the shell', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchard-home-'));
  const dir = join(home, '.config/orchard/env');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(
    join(dir, 'web.env'),
    renderEnvFile({
      projectName: 'web',
      environmentName: 'prod',
      vars: [{ key: 'WEB_URL', value: "https://x/?a=1&b='2'" }]
    })
  );
  writeFileSync(join(dir, 'api.env'), "API_URL='https://api'\n");
  writeFileSync(join(home, 'profile.sh'), ORCHARD_ENV_PROFILE);
  const out = execFileSync(
    'sh',
    ['-c', '. "$HOME/profile.sh"; sh -c \'printf "%s|%s" "$WEB_URL" "$API_URL"\''],
    { env: { HOME: home, PATH: process.env.PATH } }
  ).toString('utf8');
  assert.equal(out, "https://x/?a=1&b='2'|https://api");
});

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    projectId: PROJECT,
    environmentId: ENV,
    createdById: 'host',
    project: { id: PROJECT, name: 'Web', slug: 'web', organizationId: ORG },
    environment: { id: ENV, name: 'Production', projectId: PROJECT },
    ...overrides
  };
}

function envService(opts: {
  links?: any[];
  canEdit?: (uid: string) => boolean;
  superadmins?: string[];
  databases?: any[];
}) {
  const opened: string[] = [];
  const prisma = {
    sandbox: {
      findUnique: async () => ({
        id: SANDBOX,
        userId: 'host',
        organizationId: ORG,
        desiredState: 'running'
      })
    },
    sandboxProjectLink: { findMany: async () => opts.links ?? [linkRow()] },
    environmentSharedVar: {
      findMany: async () => [
        { key: 'APP_ENV', value: 'production', secret: false },
        { key: 'STRIPE_KEY', value: 'enc:v1:sk_live_topsecret', secret: true }
      ]
    },
    database: { findMany: async () => opts.databases ?? [] }
  };
  const authz = {
    isSuperAdmin: async (uid: string) => (opts.superadmins ?? []).includes(uid),
    resolveProjectAccess: async (_p: string, _o: string, uid: string) => ({
      canEdit: (opts.canEdit ?? ((u) => u === 'host'))(uid)
    })
  };
  const crypto = {
    open: (v: string) => {
      opened.push(v);
      return v.replace(/^enc:/, '');
    }
  };
  const cnpg = { publicTlsHostname: () => 'ns-c.db.example.com' };
  const svc = new SandboxProjectEnvService(
    prisma as never,
    crypto as never,
    authz as never,
    cnpg as never
  );
  return { svc, opened };
}

test('env files are resolved at sync time and only for links the host can still read', async () => {
  const { svc, opened } = envService({
    databases: [
      {
        name: 'main',
        dbName: 'app',
        dbUser: 'app',
        dbPassword: 'enc:dbpass',
        mode: 'cnpg',
        namespace: 'ns',
        clusterName: 'c',
        publicEnabled: true,
        publicIp: '1.2.3.4',
        publicPort: 31000
      }
    ]
  });
  const files = await svc.filesFor(SANDBOX);
  assert.deepEqual(Object.keys(files), ['web']);
  assert.match(files.web, /^APP_ENV='production'$/m);
  assert.match(files.web, /^# STRIPE_KEY is secret/m);
  assert.ok(!files.web.includes('topsecret'));
  assert.match(
    files.web,
    /DATABASE_URL='postgresql:\/\/app:dbpass@ns-c\.db\.example\.com:31000\/app/
  );
  assert.deepEqual(opened, ['enc:dbpass']);

  const revoked = envService({ canEdit: () => false });
  assert.deepEqual(await revoked.svc.filesFor(SANDBOX), {});

  const crossOrg = envService({
    links: [
      linkRow({ project: { id: PROJECT, name: 'Web', slug: 'web', organizationId: OTHER_ORG } })
    ]
  });
  assert.deepEqual(await crossOrg.svc.filesFor(SANDBOX), {});

  const guestMade = envService({ links: [linkRow({ createdById: 'guest' })], canEdit: () => true });
  assert.deepEqual(await guestMade.svc.filesFor(SANDBOX), {});

  const superMade = envService({
    links: [linkRow({ createdById: 'root' })],
    canEdit: () => true,
    superadmins: ['root']
  });
  assert.deepEqual(Object.keys(await superMade.svc.filesFor(SANDBOX)), ['web']);
});

function linksService(opts: { canEdit?: boolean; projectOrg?: string; envProject?: string } = {}) {
  const syncs: any[] = [];
  const audits: any[] = [];
  const upserts: any[] = [];
  const deletes: any[] = [];
  const prisma = {
    project: {
      findUnique: async () => ({
        id: PROJECT,
        name: 'Web',
        slug: 'web',
        organizationId: opts.projectOrg ?? ORG
      })
    },
    environment: {
      findUnique: async () => ({
        id: ENV,
        name: 'Production',
        projectId: opts.envProject ?? PROJECT
      }),
      findFirst: async () => ({ id: ENV, name: 'Production', projectId: PROJECT })
    },
    sandboxProjectLink: {
      upsert: async (args: any) => {
        upserts.push(args);
        return {
          id: 'link-1',
          projectId: PROJECT,
          createdAt: new Date(0),
          project: { id: PROJECT, name: 'Web', slug: 'web' },
          environment: { id: ENV, name: 'Production', slug: 'production' },
          createdBy: {
            id: 'host',
            username: 'host',
            firstName: 'Ho',
            lastName: 'St',
            imageUrl: null
          }
        };
      },
      findUnique: async () => ({
        id: 'link-1',
        environmentId: ENV,
        project: { id: PROJECT, slug: 'web', organizationId: ORG }
      }),
      deleteMany: async (args: any) => {
        deletes.push(args);
        return { count: 1 };
      },
      findMany: async () => [{ sandboxId: SANDBOX }]
    },
    sandbox: {
      findMany: async () => [
        {
          id: SANDBOX,
          userId: 'host',
          runner: 'kubernetes',
          podName: 'sbx-1',
          namespace: null,
          externalId: null,
          runnerState: null
        }
      ]
    }
  };
  const authz = {
    requireProjectEdit: async () => {
      if (opts.canEdit === false) throw new ForbiddenException('nope');
      return { canEdit: true };
    }
  };
  const audit = { log: async (entry: any) => audits.push(entry) };
  const registry = {
    for: () => ({ requestSecretSync: async (ref: any, by: any) => syncs.push({ ref, by }) })
  };
  const svc = new SandboxProjectLinksService(
    prisma as never,
    authz as never,
    audit as never,
    registry as never
  );
  return { svc, syncs, audits, upserts, deletes };
}

const LINK_SANDBOX = { id: SANDBOX, name: 'box', userId: 'host', organizationId: ORG };

test('attaching a project needs env-read permission, the same org and an env of that project', async () => {
  const denied = linksService({ canEdit: false });
  await assert.rejects(
    denied.svc.attach(LINK_SANDBOX, { id: 'host' }, { projectId: PROJECT }),
    ForbiddenException
  );
  assert.equal(denied.upserts.length, 0);
  assert.equal(denied.syncs.length, 0);

  const otherOrg = linksService({ projectOrg: OTHER_ORG });
  await assert.rejects(
    otherOrg.svc.attach(LINK_SANDBOX, { id: 'host' }, { projectId: PROJECT }),
    /organization/
  );

  const wrongEnv = linksService({ envProject: OTHER_ORG });
  await assert.rejects(
    wrongEnv.svc.attach(LINK_SANDBOX, { id: 'host' }, { projectId: PROJECT, environmentId: ENV }),
    /does not belong/
  );

  const ok = linksService();
  const dto = await ok.svc.attach(
    LINK_SANDBOX,
    { id: 'host', email: 'h@x' },
    { projectId: PROJECT }
  );
  assert.equal(dto.envFile, '~/.config/orchard/env/web.env');
  assert.equal(ok.upserts[0].create.environmentId, ENV);
  assert.equal(ok.audits[0].action, 'sandbox.project.attached');
  assert.equal(ok.syncs.length, 1);
  assert.deepEqual(Object.keys(ok.syncs[0].ref).sort(), [
    'externalId',
    'id',
    'namespace',
    'podName',
    'runner',
    'runnerState',
    'userId'
  ]);
});

test('detaching is audited and resyncs the box; env changes resync linked boxes', async () => {
  const { svc, syncs, audits, deletes } = linksService();
  await svc.detach(LINK_SANDBOX, { id: 'host' }, PROJECT);
  assert.equal(deletes.length, 1);
  assert.equal(audits[0].action, 'sandbox.project.detached');
  assert.equal(syncs.length, 1);
  svc.onModuleInit();
  signalEnvironmentEnvChanged({ environmentId: ENV, projectId: PROJECT });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(syncs.length, 2);
  svc.onModuleDestroy();
  signalEnvironmentEnvChanged({ environmentId: ENV });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(syncs.length, 2);
  const off = onEnvironmentEnvChanged(() => {
    throw new Error('listener errors are contained');
  });
  signalEnvironmentEnvChanged({ environmentId: ENV });
  off();
});

function k8sRunner(status: string) {
  const enqueued: any[] = [];
  const execs: any[] = [];
  const secrets: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  const row = {
    id: SANDBOX,
    userId: 'host',
    runner: 'kubernetes',
    podName: 'sbx-1',
    namespace: 'orchard-sandboxes',
    externalId: null,
    runnerState: null,
    status,
    desiredState: 'running',
    sshIdentityId: null,
    setupScript: null
  };
  const prisma = {
    sandbox: {
      findUnique: async () => row,
      updateMany: async () => ({ count: 1 })
    }
  };
  const runner = new KubernetesSandboxRunner(
    { kc: {} } as never,
    prisma as never,
    { get: async () => 'inst-1', createIfAbsent: async () => true } as never,
    { enqueue: async (input: any) => enqueued.push(input) } as never,
    { registerHandler: (op: string, fn: any) => handlers.set(op, fn) } as never,
    {
      forSandbox: async () => ({
        authorizedKeys: [],
        githubToken: null,
        claudeToken: null,
        openaiToken: null,
        setupScript: null,
        mcpToken: null,
        opencodePassword: null,
        bridgeToken: null,
        attachedEnv: { web: "STRIPE_PUBLIC='pk_live_abc'\n" }
      })
    } as never
  );
  (runner as any).core = () => ({
    readNamespacedSecret: async () => ({}),
    replaceNamespacedSecret: async (_n: string, _ns: string, body: any) => secrets.push(body)
  });
  (runner as any).exec = async (ref: any, command: string[], opts: any) => {
    execs.push({ ref, command, stdin: opts?.stdin?.toString('utf8') });
    return { ok: true, exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, enqueued, execs, secrets, handlers };
}

test('env files are built inside the secret sync op, never carried in the queue', async () => {
  const { runner, enqueued, execs, secrets, handlers } = k8sRunner('running');
  await runner.requestSecretSync(
    {
      id: SANDBOX,
      userId: 'host',
      runner: 'kubernetes',
      podName: 'sbx-1',
      namespace: null,
      externalId: null,
      runnerState: null
    },
    'host'
  );
  assert.deepEqual(enqueued[0].manifest, { sandboxId: SANDBOX });
  assert.equal(enqueued[0].opType, SANDBOX_OP_SECRET);
  assert.ok(!JSON.stringify(enqueued).includes('pk_live'));
  await handlers.get(SANDBOX_OP_SECRET)!({ manifest: { sandboxId: SANDBOX } });
  const bundle = secrets[0].stringData[ORCHARD_ENV_INIT_FILE];
  assert.deepEqual(parseOrchardEnvBundle(bundle), { web: "STRIPE_PUBLIC='pk_live_abc'\n" });
  const envSync = execs.filter((e) => e.command.join(' ').includes('orchard_env_sync'));
  assert.equal(envSync.length, 1);
  assert.equal(envSync[0].stdin, bundle);
  assert.ok(!envSync[0].command.join(' ').includes('pk_live'));

  const cr = runner.buildCr(
    {
      id: SANDBOX,
      userId: 'host',
      runner: 'kubernetes',
      podName: 'sbx-1',
      namespace: null,
      externalId: null,
      runnerState: null,
      repoUrl: null,
      image: 'img',
      cpuLimit: '1',
      memoryLimit: '1Gi',
      diskSize: '10Gi',
      setupScript: null
    },
    'inst-1'
  );
  const init = cr.spec.podTemplate.spec.volumes.find((v: any) => v.name === 'init');
  const item = init.secret.items.find((i: any) => i.key === ORCHARD_ENV_INIT_FILE);
  assert.deepEqual(item, { key: ORCHARD_ENV_INIT_FILE, path: ORCHARD_ENV_INIT_FILE, mode: 0o600 });
  assert.ok(!JSON.stringify(cr).includes('pk_live'));

  const stopped = k8sRunner('stopped');
  await stopped.handlers.get(SANDBOX_OP_SECRET)!({ manifest: { sandboxId: SANDBOX } });
  assert.equal(stopped.execs.length, 0);
  assert.equal(stopped.secrets.length, 1);
});

test('vercel stages the env bundle as a 0600 init file', () => {
  const files = stagedInitFiles({
    authorizedKeys: [],
    githubToken: null,
    claudeToken: null,
    openaiToken: null,
    setupScript: null,
    mcpToken: null,
    opencodePassword: null,
    bridgeToken: null,
    attachedEnv: { api: 'A=1\n' }
  });
  assert.deepEqual(parseOrchardEnvBundle(files[ORCHARD_ENV_INIT_FILE]), { api: 'A=1\n' });
  assert.ok(SECRET_INIT_FILES.includes(ORCHARD_ENV_INIT_FILE));
});

test('preview environments are named gh-<session slug> within environment slug rules', () => {
  assert.equal(previewEnvSlug('fix-login-a1b2c3'), 'gh-fix-login-a1b2c3');
  const long = previewEnvSlug(`${'very-long-title-'.repeat(5)}abc123`);
  assert.ok(long.startsWith('gh-'));
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith('abc123'));
  assert.match(long, /^[a-z0-9-]+$/);
  assert.ok(!long.startsWith('gh--'));
  assert.equal(previewEnvSlug('Weird_Slug!!'), 'gh-weird-slug');
});

test('preview status follows the build and rollout state', () => {
  const base = {
    id: 'd',
    status: 'pending',
    buildStatus: 'none',
    stopped: false,
    applyStatus: 'synced'
  };
  assert.equal(previewStatusOf(null), 'gone');
  assert.equal(previewStatusOf({ ...base, buildStatus: 'building' }), 'building');
  assert.equal(previewStatusOf({ ...base, buildStatus: 'failed' }), 'failed');
  assert.equal(previewStatusOf({ ...base, buildStatus: 'succeeded', status: 'running' }), 'ready');
  assert.equal(
    previewStatusOf({
      ...base,
      buildStatus: 'succeeded',
      status: 'running',
      applyStatus: 'pending'
    }),
    'deploying'
  );
  assert.equal(previewStatusOf({ ...base, buildStatus: 'succeeded', stopped: true }), 'stopped');
  assert.equal(previewStatusOf({ ...base, buildStatus: 'succeeded' }), 'deploying');
  delete process.env.PUBLIC_HTTPS_PORT;
  assert.equal(
    previewUrlOf([{ host: 'app-x.orchard.test', path: '/', tlsSecretName: 'w', entrypoints: [] }]),
    'https://app-x.orchard.test/'
  );
});

test('push output and source env are parsed and copied safely', () => {
  assert.deepEqual(parsePushedHead(`${SHA}\norchard/fix-a1b2c3\ngit@github.com:Acme/App.git\n`), {
    commit: SHA,
    branch: 'orchard/fix-a1b2c3',
    repo: 'acme/app'
  });
  assert.equal(parsePushedHead(`${SHA}\nHEAD\nhttps://github.com/a/b\n`).branch, null);
  const { env, skipped } = cloneEnv(
    [
      { key: 'DATABASE_URL', value: '${{resource.db.connectionString}}' },
      { key: 'TOKEN', value: '${{shared.SECRET}}' },
      { key: 'NAME', value: 'web-${{shared.REGION}}' },
      { key: 'OWN_SECRET', value: 'shh', secret: true }
    ],
    [
      { key: 'SECRET', value: 'sekret', secret: true },
      { key: 'REGION', value: 'eu' }
    ]
  );
  assert.deepEqual(skipped, ['DATABASE_URL', 'TOKEN', 'OWN_SECRET']);
  assert.deepEqual(env, [{ key: 'NAME', value: 'web-eu', secret: false }]);
  assert.ok(!JSON.stringify(env).includes('sekret'), 'secret values never reach a preview build');
  assert.ok(!JSON.stringify(env).includes('shh'));
});

function previewHarness(opts: { canEdit?: boolean; existingEnv?: any } = {}) {
  const calls: string[] = [];
  const audits: any[] = [];
  const session: any = {
    id: SID,
    sandboxId: SANDBOX,
    slug: 'fix-login-a1b2c3',
    branch: 'orchard/fix-login-a1b2c3',
    repo: 'app',
    worktreePath: '/persist/home/.worktrees/app/fix-login-a1b2c3',
    archivedAt: null,
    previewDeploymentId: null,
    previewEnvironmentId: null,
    previewUrl: null
  };
  const envs: any[] = [
    { id: ENV, projectId: PROJECT, slug: 'production', isDefault: true, isProduction: true }
  ];
  if (opts.existingEnv) envs.push(opts.existingEnv);
  const deployments: any[] = [
    {
      id: SOURCE,
      projectId: PROJECT,
      environmentId: ENV,
      name: 'web',
      githubRepo: 'https://github.com/acme/app',
      githubBranch: 'main',
      gitConnectionId: null,
      externalRepoId: null,
      buildType: 'dockerfile',
      dockerfilePath: 'Dockerfile',
      dockerfileTarget: null,
      buildFromRoot: false,
      rootDirectory: null,
      framework: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      cpuRequestMilli: 250,
      memoryRequestBytes: BigInt(268435456),
      composeStackId: null,
      templateInstanceId: null,
      environment: envs[0],
      envVars: [{ key: 'MODE', value: '${{shared.MODE}}', secret: false }],
      volumes: [],
      services: [{ ports: [{ name: 'http', port: 3000, targetPort: 3000, protocol: 'TCP' }] }]
    }
  ];
  const prisma = {
    sandboxConversation: {
      findFirst: async (args: any) => (args.where.previewEnvironmentId ? null : session),
      update: async (args: any) => Object.assign(session, args.data),
      updateMany: async (args: any) => {
        Object.assign(session, args.data);
        return { count: 1 };
      }
    },
    project: {
      findUnique: async (args: any) => ({
        id: args.where.id,
        name: 'Web',
        slug: 'web',
        organizationId: ORG
      })
    },
    deployment: {
      findUnique: async (args: any) => deployments.find((d) => d.id === args.where.id) ?? null,
      findMany: async () => deployments.filter((d) => d.id === SOURCE),
      findFirst: async (args: any) =>
        deployments.find(
          (d) => d.environmentId === args.where.environmentId && d.name === args.where.name
        ) ?? null,
      update: async (args: any) => {
        const d = deployments.find((x) => x.id === args.where.id);
        Object.assign(d, args.data);
        return d;
      }
    },
    environment: {
      findUnique: async (args: any) =>
        args.where.id
          ? (envs.find((e) => e.id === args.where.id) ?? null)
          : (envs.find(
              (e) =>
                e.projectId === args.where.projectId_slug.projectId &&
                e.slug === args.where.projectId_slug.slug
            ) ?? null)
    },
    environmentSharedVar: {
      findMany: async () => [{ key: 'MODE', value: 'prod', secret: false }]
    },
    ingress: {
      findMany: async () => [
        { host: 'web-web-abc123.orchard.test', path: '/', tlsSecretName: 'w', entrypoints: [] }
      ]
    }
  };
  let created: any = null;
  const services = {
    environments: {
      createEnvironment: async (projectId: string, input: any) => {
        calls.push(`env.create:${input.slug}`);
        const env = {
          id: 'env-preview',
          projectId,
          slug: input.slug,
          name: input.name,
          namespace: `org-web-${input.slug}`,
          isDefault: false,
          isProduction: false,
          project: { organizationId: ORG }
        };
        envs.push(env);
        return env;
      },
      deleteEnvironment: async (id: string, actor: any, confirm: string) => {
        calls.push(`env.delete:${id}:${actor.userId}:${confirm}`);
      },
      deleteEnvironmentFromCluster: async (id: string, cause: any) => {
        calls.push(`env.system-delete:${id}:${cause.reason}`);
      }
    },
    deployments: {
      createDeploymentFromGitHub: async (projectId: string, body: any) => {
        calls.push('deploy.create');
        created = body;
        const d = {
          id: 'dep-preview',
          projectId,
          environmentId: body.environmentId,
          name: body.name,
          githubBranch: body.branch
        };
        deployments.push(d);
        return d;
      },
      rebuildDeployment: async (id: string) => {
        calls.push(`deploy.rebuild:${id}`);
      }
    },
    ingress: {
      createAutoIngressForDeployment: async (id: string) => {
        calls.push(`ingress:${id}`);
        return null;
      }
    }
  };
  const authz = {
    requireProjectEdit: async () => {
      if (opts.canEdit === false) throw new ForbiddenException('no edit');
      return { canEdit: true };
    }
  };
  const workspace = {
    gitPush: async () => {
      calls.push('push');
      return { ok: true, output: '' };
    },
    runIn: async () => ({
      ok: true,
      exitCode: 0,
      stdout: `${SHA}\norchard/fix-login-a1b2c3\nhttps://github.com/acme/app.git\n`
    })
  };
  const sessions = {
    setPreviewHooks: () => undefined,
    notifyChanged: async () => ({ ...session }),
    get: async () => ({ ...session })
  };
  const svc = new SandboxPreviewDeployService(
    prisma as never,
    {} as never,
    authz as never,
    { log: async (e: any) => audits.push(e) } as never,
    { maybeDecrypt: (v: any) => v } as never,
    workspace as never,
    sessions as never
  );
  (svc as any).projectServices = async () => services;
  return { svc, calls, audits, session, envs, created: () => created };
}

const PREVIEW_SANDBOX = {
  id: SANDBOX,
  name: 'box',
  userId: 'host',
  organizationId: ORG,
  status: 'running',
  runner: 'kubernetes' as const,
  podName: 'sbx-1',
  namespace: null,
  externalId: null,
  runnerState: null,
  repoUrl: null
};

const ACTOR = { id: 'host', email: 'host@example.com', clerkId: 'host-clerk' };

test('preview deploy needs project edit before anything is pushed', async () => {
  const h = previewHarness({ canEdit: false });
  await assert.rejects(
    h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT }),
    ForbiddenException
  );
  assert.deepEqual(h.calls, []);
  await assert.rejects(
    h.svc.deploy({ ...PREVIEW_SANDBOX, organizationId: OTHER_ORG }, SID, ACTOR, {
      projectId: PROJECT
    }),
    /organization/
  );
  assert.deepEqual(h.calls, []);
});

test('preview deploy clones the source into gh-<slug>, then redeploys on the second call', async () => {
  const h = previewHarness();
  const first = await h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT });
  assert.deepEqual(h.calls, [
    'push',
    'env.create:gh-fix-login-a1b2c3',
    'deploy.create',
    'ingress:dep-preview'
  ]);
  assert.equal(first.redeployed, false);
  assert.equal(first.url, 'https://web-web-abc123.orchard.test/');
  assert.equal(first.commit, SHA);
  assert.equal(h.session.previewDeploymentId, 'dep-preview');
  assert.equal(h.session.previewEnvironmentId, 'env-preview');
  assert.equal(h.session.previewUrl, 'https://web-web-abc123.orchard.test/');
  const body = h.created();
  assert.equal(body.branch, 'orchard/fix-login-a1b2c3');
  assert.equal(body.environmentId, 'env-preview');
  assert.equal(body.name, 'web');
  assert.deepEqual(body.env, [{ key: 'MODE', value: 'prod', secret: false }]);
  assert.deepEqual(body.ports, [
    { name: 'http', containerPort: 3000, servicePort: 3000, protocol: 'TCP' }
  ]);
  assert.equal(body.memoryRequestBytes, 268435456);
  assert.equal(h.audits[0].action, 'sandbox.session.preview.deployed');

  h.calls.length = 0;
  const second = await h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT });
  assert.deepEqual(h.calls, ['push', 'deploy.rebuild:dep-preview', 'ingress:dep-preview']);
  assert.equal(second.redeployed, true);
  assert.equal(second.deploymentId, 'dep-preview');
  assert.equal(h.audits[1].action, 'sandbox.session.preview.redeployed');

  await assert.rejects(
    h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, {
      projectId: '99999999-9999-4999-8999-999999999999'
    }),
    /another project/
  );
});

test('an existing non-preview environment with the same slug is never reused', async () => {
  const h = previewHarness({
    existingEnv: {
      id: 'env-x',
      projectId: PROJECT,
      slug: 'gh-fix-login-a1b2c3',
      isDefault: true,
      isProduction: false
    }
  });
  await assert.rejects(
    h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT }),
    /not a preview environment/
  );
  assert.ok(!h.calls.includes('deploy.create'));
});

test('removing or archiving tears down only the preview environment, through the audited path', async () => {
  const h = previewHarness();
  await h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT });
  h.calls.length = 0;
  const removed = await h.svc.remove(PREVIEW_SANDBOX, SID, ACTOR);
  assert.equal(removed.removed, true);
  assert.deepEqual(h.calls, ['env.delete:env-preview:host:gh-fix-login-a1b2c3']);
  assert.equal(h.session.previewDeploymentId, null);
  assert.equal(h.session.previewEnvironmentId, null);
  assert.equal(h.audits.at(-1).action, 'sandbox.session.preview.removed');

  await h.svc.deploy(PREVIEW_SANDBOX, SID, ACTOR, { projectId: PROJECT });
  h.calls.length = 0;
  await h.svc.teardownForSession(PREVIEW_SANDBOX, { ...h.session }, 'archived');
  assert.deepEqual(h.calls, ['env.system-delete:env-preview:sandbox.session.archived']);
  assert.equal(h.audits.at(-1).metadata.reason, 'archived');

  h.calls.length = 0;
  h.session.previewEnvironmentId = ENV;
  h.session.previewDeploymentId = SOURCE;
  await h.svc.teardownForSession(PREVIEW_SANDBOX, { ...h.session }, 'archived');
  assert.deepEqual(h.calls, []);
  assert.equal(h.session.previewEnvironmentId, null);
});

const SENTINEL = new Error('gate');

test('link and preview routes are host-only except listing', async () => {
  const calls: string[] = [];
  const access = {
    async requireSandboxRole(_id: string, _u: string, min: string) {
      calls.push(min);
      throw SENTINEL;
    }
  };
  const users = { findOrCreateByClerkId: async () => ({ id: 'u1', email: 'u1@x' }) };
  const c = new SandboxLinksController(
    access as never,
    {} as never,
    {} as never,
    users as never,
    { configured: false } as never
  );
  const req = { user: { sub: 'u1', email: 'u1@x' } };
  const routes: Array<[string, () => Promise<unknown>]> = [
    ['viewer', () => c.list(req, SANDBOX)],
    ['owner', () => c.attach(req, SANDBOX, { projectId: PROJECT })],
    ['owner', () => c.detach(req, SANDBOX, PROJECT)],
    ['owner', () => c.previewDeploy(req, SANDBOX, SID, { projectId: PROJECT })],
    ['owner', () => c.previewRemove(req, SANDBOX, SID)]
  ];
  for (const [min, run] of routes) {
    calls.length = 0;
    await run().catch((e) => {
      if (e !== SENTINEL) throw e;
    });
    assert.deepEqual(calls, [min]);
  }
  const methods = Object.getOwnPropertyNames(SandboxLinksController.prototype).filter(
    (m) => m !== 'constructor' && m !== 'access' && m !== 'actor'
  );
  assert.equal(methods.length, routes.length);
});

test('sessions report preview status and hand archive and delete to the preview teardown', async () => {
  const row: any = {
    id: SID,
    sandboxId: SANDBOX,
    title: 'Fix login',
    slug: 'fix-login-a1b2c3',
    repo: 'app',
    branch: 'orchard/fix-login-a1b2c3',
    baseBranch: 'main',
    baseCommit: null,
    worktreePath: '/persist/home/.worktrees/app/fix-login-a1b2c3',
    agent: 'opencode',
    opencodeSessionId: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    previewDeploymentId: 'dep-preview',
    previewEnvironmentId: 'env-preview',
    previewUrl: 'https://stale.example/',
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: null
  };
  const torn: string[] = [];
  const prisma = {
    sandboxConversation: {
      findFirst: async () => ({ ...row }),
      findMany: async () => [{ ...row }],
      update: async (args: any) => ({ ...row, ...args.data }),
      delete: async () => row
    },
    deployment: {
      findMany: async () => [
        {
          id: 'dep-preview',
          status: 'running',
          buildStatus: 'succeeded',
          stopped: false,
          applyStatus: 'synced',
          ingresses: [
            { host: 'web-x.orchard.test', path: '/', tlsSecretName: 'w', entrypoints: [] }
          ]
        }
      ]
    }
  };
  const svc = new SandboxSessionsService(prisma as never, {} as never, {} as never, {} as never);
  svc.setPreviewHooks({
    teardown: async (_sb, r, reason) => {
      torn.push(`${reason}:${r.previewEnvironmentId}`);
    }
  });
  const stopped = { ...PREVIEW_SANDBOX, status: 'stopped' };
  const { sessions } = await svc.list(stopped);
  assert.equal(sessions[0].previewStatus, 'ready');
  assert.equal(sessions[0].previewUrl, 'https://web-x.orchard.test/');
  await svc.update(stopped, SID, { archived: true });
  await svc.remove(stopped, SID);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(torn, ['archived:env-preview', 'deleted:env-preview']);
});
