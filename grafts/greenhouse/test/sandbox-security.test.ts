import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createServer } from 'node:http';
import { HOME_GUARD, buildFsScript } from '../server/src/sandboxes/sandbox-session-commands';
import { SandboxSecretsService } from '../server/src/sandboxes/runners/sandbox-secrets';
import { previewDomainConflict } from '../server/src/sandboxes/preview/preview-auth';
import { renderEnvFile } from '../server/src/sandboxes/links/sandbox-env-files';
import {
  endGuestShells,
  guestShellKillScript,
  rotateMachineSecrets
} from '../server/src/sandboxes/sandbox-member-offboarding';
import { requestAuthStorage } from '../server/src/core/request-context';
import { IntegrationsController } from '../server/src/sandboxes/integrations/integrations.controller';
import {
  OPENCODE_ROTATING,
  SandboxWorkspaceService,
  gitOutput
} from '../server/src/sandboxes/sandbox-workspace.service';
import { HttpException } from '@nestjs/common';
import { SandboxMembersService } from '../server/src/sandboxes/sandbox-members.service';
import { SandboxSessionsController } from '../server/src/sandboxes/sandbox-sessions.controller';
import { RateLimitService, SANDBOX_RATE_LIMITS } from '../server/src/core/rate-limit.service';
import { withRole } from '../server/src/sandboxes/sandboxes.service';
import { parseRepoUrl } from '../server/src/sandboxes/sandbox-repo-url';
import { sandboxMcpDevice, sandboxMcpOrgScope } from '../server/src/sandboxes/sandbox-mcp-scope';
import {
  OPENCODE_RESPONSE_HEADERS,
  newOpencodeMessageId,
  opencodeContentType,
  opencodeMinRole
} from '../server/src/sandboxes/sandbox-opencode-policy';

const ORG = '44444444-4444-4444-8444-444444444444';
const SANDBOX = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';

test('the sandbox MCP token is minted on a session confined to the sandbox organization', async () => {
  const prevUrl = process.env.SANDBOX_MCP_URL;
  const prevSecret = process.env.JWT_SECRET;
  process.env.SANDBOX_MCP_URL = 'https://mcp.example.com';
  process.env.JWT_SECRET = 'x'.repeat(48);
  const calls: string[] = [];
  const minted: any[] = [];
  const prisma = { sandbox: { findUnique: async () => ({ organizationId: ORG }) } };
  const auth = {
    revokeDeviceSessions: async (userId: string, names: string[]) => {
      calls.push(`revoke:${userId}:${names.join(',')}`);
      return 1;
    },
    mintDeviceToken: async (input: any) => {
      calls.push('mint');
      minted.push(input);
      return 'minted-token';
    }
  };
  try {
    const service = new SandboxSecretsService(prisma as any, {} as any, auth, {
      getValidUserToken: async () => null
    });
    assert.equal(await service.mintMcpToken(HOST, SANDBOX), 'minted-token');
    assert.deepEqual(calls, [`revoke:${HOST}:sandbox-mcp`, 'mint']);
    assert.deepEqual(minted, [
      {
        userId: HOST,
        deviceName: `sandbox-mcp:${ORG}:${SANDBOX}`,
        ttlDays: 60,
        reuseIfValidForDays: 7
      }
    ]);
    assert.equal(minted[0].deviceName, sandboxMcpDevice(ORG, SANDBOX));
    assert.equal(sandboxMcpOrgScope(minted[0].deviceName), ORG);
  } finally {
    process.env.SANDBOX_MCP_URL = prevUrl;
    process.env.JWT_SECRET = prevSecret;
  }
});

test('only well formed sandbox MCP device names carry an org scope', () => {
  assert.equal(sandboxMcpOrgScope('sandbox-mcp'), undefined);
  assert.equal(sandboxMcpOrgScope('MCP Client'), undefined);
  assert.equal(sandboxMcpOrgScope(null), undefined);
  assert.equal(sandboxMcpOrgScope('sandbox-mcp:not-a-uuid'), undefined);
  assert.equal(sandboxMcpOrgScope(`sandbox-mcp:${ORG}`), ORG);
  assert.equal(sandboxMcpOrgScope(sandboxMcpDevice(ORG, SANDBOX)), ORG);
  assert.equal(sandboxMcpOrgScope(sandboxMcpDevice(null, SANDBOX)), undefined);
});

test('guests cannot read the agent config that holds the MCP token through the proxy', () => {
  assert.equal(opencodeMinRole('GET', 'config'), 'owner');
  assert.equal(opencodeMinRole('GET', 'mcp'), 'owner');
  assert.equal(opencodeMinRole('GET', 'config/providers'), 'collaborator');
  assert.equal(opencodeMinRole('GET', 'provider'), 'collaborator');
  assert.equal(opencodeMinRole('GET', 'doc'), 'viewer');
  assert.equal(opencodeMinRole('POST', 'doc'), 'owner');
});

test('opencode paths with characters the policy and upstream could read differently need the host', () => {
  assert.equal(opencodeMinRole('GET', 'conf{i}g'), 'owner');
  assert.equal(opencodeMinRole('POST', 'session/ses_a/prompt_asyn{c}'), 'owner');
  assert.equal(opencodeMinRole('GET', 'session/ses_a;x/message'), 'owner');
  assert.equal(opencodeMinRole('GET', 'session/ses_a/message?x={y}'), 'viewer');
});

test('proxied opencode responses can never render as a page on the Orchard origin', () => {
  assert.equal(opencodeContentType('text/html; charset=utf-8'), 'application/octet-stream');
  assert.equal(opencodeContentType('image/svg+xml'), 'application/octet-stream');
  assert.equal(opencodeContentType('application/xhtml+xml'), 'application/octet-stream');
  assert.equal(opencodeContentType(undefined), 'application/json');
  assert.equal(opencodeContentType('application/json'), 'application/json');
  assert.equal(opencodeContentType('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(opencodeContentType('text/event-stream'), 'text/event-stream');
  assert.equal(opencodeContentType(['text/html', 'application/json']), 'application/octet-stream');
  assert.equal(OPENCODE_RESPONSE_HEADERS['x-content-type-options'], 'nosniff');
  assert.match(OPENCODE_RESPONSE_HEADERS['content-security-policy'], /sandbox/);
  assert.match(OPENCODE_RESPONSE_HEADERS['content-security-policy'], /default-src 'none'/);
});

function proxyHarness(baseUrl: string) {
  const service = Object.create(SandboxWorkspaceService.prototype);
  service.logger = { warn: () => {} };
  service.registry = {
    for: () => ({
      httpTarget: async () => ({ kind: 'url', baseUrl, headers: { authorization: 'Basic new' } })
    })
  };
  const chunks: Buffer[] = [];
  const res: any = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.headers = {} as Record<string, string>;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.flushHeaders = () => (res.headersSent = true);
  res.json = (body: unknown) => {
    res.headersSent = true;
    res.end(JSON.stringify(body));
  };
  const sandbox = {
    id: SANDBOX,
    userId: HOST,
    runner: 'vercel',
    podName: 'p',
    namespace: null,
    externalId: null,
    runnerState: null,
    status: 'running'
  };
  const req: any = {
    method: 'GET',
    originalUrl: `/apiv1/sandboxes/${SANDBOX}/opencode/event`,
    headers: {}
  };
  return { service, res, req, sandbox, body: () => Buffer.concat(chunks).toString('utf8') };
}

test('an opencode restarting with a rotated password answers 503, and a dropped stream ends cleanly', async () => {
  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== 'Basic new') {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="opencode"' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"server.connected"}\n\n');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as any).port;
  try {
    const stale = proxyHarness(`http://127.0.0.1:${port}`);
    stale.service.registry = {
      for: () => ({
        httpTarget: async () => ({
          kind: 'url',
          baseUrl: `http://127.0.0.1:${port}`,
          headers: { authorization: 'Basic old' }
        })
      })
    };
    await stale.service.proxyOpencode(stale.sandbox, stale.req, stale.res);
    assert.equal(stale.res.statusCode, 503);
    assert.deepEqual(JSON.parse(stale.body()), OPENCODE_ROTATING);
    assert.equal(stale.res.headers['www-authenticate'], undefined);
    const live = proxyHarness(`http://127.0.0.1:${port}`);
    await live.service.proxyOpencode(live.sandbox, live.req, live.res);
    assert.equal(live.res.statusCode, 200);
    assert.match(live.body(), /server\.connected/);
    assert.equal(live.res.writableEnded, true, 'the browser stream is closed so it reconnects');
  } finally {
    upstream.close();
  }
});

test('a preview domain on the same site as Orchard is refused', () => {
  assert.ok(
    previewDomainConflict('preview.example.com', { frontendUrl: 'https://app.example.com' })
  );
  assert.ok(
    previewDomainConflict('preview.example.co.uk', { apiUrl: 'https://api.example.co.uk' })
  );
  assert.ok(previewDomainConflict('example-preview.com', { cookieDomain: 'example-preview.com' }));
  assert.equal(
    previewDomainConflict('preview.example.dev', { frontendUrl: 'https://app.example.com' }),
    null
  );
  assert.equal(
    previewDomainConflict('example-preview.co.uk', { frontendUrl: 'https://app.example.co.uk' }),
    null
  );
});

test('project variables that would hijack git, the shell, the agent or TLS never reach the env file', () => {
  const hostile = [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_EXTERNAL_DIFF',
    'GIT_SSH_COMMAND',
    'PROMPT_COMMAND',
    'PS0',
    'BASH_FUNC_ls%%',
    'NODE_OPTIONS',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'RUBYOPT',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'SSH_AUTH_SOCK',
    'PAGER',
    'EDITOR',
    'LESSOPEN',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'CURL_CA_BUNDLE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'OPENAI_BASE_URL',
    'OPENCODE_CONFIG',
    'ORCHARD_GIT_TOKEN',
    'npm_config_script_shell',
    'XDG_CONFIG_HOME'
  ];
  const vars = [
    ...hostile.map((key) => ({ key, value: 'evil' })),
    { key: 'DATABASE_URL', value: 'postgres://x' },
    { key: 'NEXT_PUBLIC_API', value: 'https://api' },
    { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-app' },
    { key: 'HTTPS_PROXY', value: 'http://proxy:3128' },
    { key: 'PYTHONUNBUFFERED', value: '1' }
  ];
  const file = renderEnvFile({ projectName: 'p', environmentName: 'e', vars });
  for (const key of hostile) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    assert.ok(!file.includes(`\n${key}=`), `${key} must be skipped`);
  }
  assert.match(file, /\nDATABASE_URL='postgres:\/\/x'/);
  assert.match(file, /\nNEXT_PUBLIC_API='https:\/\/api'/);
  for (const key of ['ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'PYTHONUNBUFFERED']) {
    assert.ok(file.includes(`\n${key}=`), `${key} is an ordinary app variable`);
  }
});

test('losing a guest revokes the MCP session, bumps the secret epoch and resyncs the machine', async () => {
  const revoked: any[] = [];
  const synced: string[] = [];
  const steps: string[] = [];
  let epoch = 2;
  const prisma = {
    sandbox: {
      updateMany: async (args: any) => {
        assert.deepEqual(args, { where: { id: SANDBOX }, data: { secretEpoch: { increment: 1 } } });
        epoch += args.data.secretEpoch.increment;
        steps.push('epoch');
        return { count: 1 };
      }
    }
  };
  const sessions = {
    revokeDeviceSessions: async (userId: string, deviceNames: string[]) => {
      revoked.push({ userId, deviceNames });
      return 1;
    }
  };
  const registry = {
    for: () => ({
      requestSecretSync: async (ref: any) => {
        steps.push(`sync@${epoch}`);
        synced.push(ref.id);
      }
    })
  };
  const box = { id: SANDBOX, userId: HOST, organizationId: ORG } as any;
  assert.equal(await rotateMachineSecrets(prisma as any, sessions, registry as any, box, HOST), 1);
  assert.deepEqual(revoked, [
    { userId: HOST, deviceNames: ['sandbox-mcp', sandboxMcpDevice(ORG, SANDBOX)] }
  ]);
  assert.deepEqual(synced, [SANDBOX]);
  assert.deepEqual(steps, ['epoch', 'sync@3'], 'the sync is queued after the epoch moved');
});

test('integration account links refuse scoped tokens and org-confined sessions', async () => {
  const touched: string[] = [];
  const issues = new Proxy({}, { get: (_t, name) => async () => touched.push(String(name)) });
  const slack = new Proxy({}, { get: (_t, name) => async () => touched.push(String(name)) });
  const users = { findOrCreateByClerkId: async () => ({ id: HOST }) };
  const controller = new IntegrationsController(
    issues as any,
    slack as any,
    {} as any,
    users as any,
    { configured: false } as any
  );
  const req = { user: { sub: HOST } };
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['connectLinear', () => controller.connectLinear(req, { apiKey: 'lin_api_x' })],
    ['disconnectLinear', () => controller.disconnectLinear(req)],
    ['linearIssues', () => controller.linearIssues(req, 'q')],
    ['linearStatus', () => controller.linearStatus(req)],
    ['unlinkSlack', () => controller.unlinkSlack(req)],
    ['linkSlack', () => controller.linkSlack(req, { token: 't' })]
  ];
  for (const ctx of [{ tokenProjectIds: ['p1'] }, { sessionOrgId: ORG }, { apiTokenId: 'tok' }]) {
    for (const [name, call] of calls) {
      if ('apiTokenId' in ctx && !['connectLinear', 'linkSlack'].includes(name)) continue;
      await assert.rejects(
        requestAuthStorage.run(ctx, call),
        (e: any) => e.getStatus?.() === 403,
        `${name} with ${JSON.stringify(ctx)}`
      );
    }
  }
  assert.deepEqual(touched, []);
  await requestAuthStorage.run({}, () => controller.linearStatus(req));
  assert.deepEqual(touched, ['linearStatus']);
});

test('only the host sees the setup script, and repo URLs cannot carry credentials', () => {
  const dto = {
    id: 'x',
    setupScript: 'export TOKEN=sk-live',
    repoUrl: 'https://x:ghp_legacy@github.com/acme/api'
  } as any;
  assert.equal(withRole(dto, 'owner').setupScript, 'export TOKEN=sk-live');
  for (const role of ['collaborator', 'viewer', 'admin'] as const) {
    const scrubbed = withRole(dto, role);
    assert.equal(scrubbed.setupScript, null);
    assert.equal(scrubbed.repoUrl, 'https://github.com/acme/api');
    assert.equal(scrubbed.myRole, role);
  }
  assert.equal(withRole({ ...dto, repoUrl: null }, 'admin').repoUrl, null);
  assert.throws(() => parseRepoUrl('https://x:ghp_secret@github.com/acme/api'), /credentials/);
  assert.throws(() => parseRepoUrl('https://ghp_secret@github.com/acme/api'), /credentials/);
  assert.throws(() => parseRepoUrl('http://github.com/acme/api'), /https/);
  assert.throws(() => parseRepoUrl('nope'), /valid URL/);
  assert.equal(parseRepoUrl('https://github.com/acme/api.git').hostname, 'github.com');
});

test('fs scripts never touch the worktrees folder itself and resolve the rename target before creating it', () => {
  const guard = HOME_GUARD[1];
  const ok = (path: string) =>
    spawnSync('/bin/sh', ['-c', `__home=/h; ${guard}; home_ok ${path}`]).status === 0;
  assert.equal(ok('/h/.worktrees'), false);
  assert.equal(ok('/h/.worktrees/app'), false);
  assert.equal(ok('/h/.worktrees/app/fix-1'), true);
  assert.equal(ok('/h/.worktrees/app/fix-1/src/a.ts'), true);
  assert.equal(ok('/h/.config'), false);
  assert.equal(ok('/h/app/src'), true);
  const rename = buildFsScript('rename', '/h/app', '/h', 'a.txt', 'out/new/b.txt');
  const mkdirAt = rename.indexOf('mkdir -p');
  const checkAt = rename.indexOf('inside "$dp"');
  assert.ok(
    checkAt > 0 && checkAt < mkdirAt,
    'the destination folder is confined before it is created'
  );
});

test('git output returned to the browser never carries credentials embedded in a remote URL', () => {
  assert.equal(
    gitOutput('fatal: unable to access https://x-access-token:ghu_abc@github.com/a/b.git/'),
    'fatal: unable to access https://***@github.com/a/b.git/'
  );
  assert.equal(
    gitOutput('To https://github.com/a/b\n  main -> main'),
    'To https://github.com/a/b\n  main -> main'
  );
  assert.equal(gitOutput('x'.repeat(3000)).length, 2000);
});

test('prompts and new sessions go through the shared per-person rate limiter', async () => {
  const checks: string[] = [];
  const rateLimit = {
    checkRateLimit: async (id: string, type: string, action: string) => {
      checks.push(`${id}:${type}:${action}`);
      if (action === 'sandbox_prompt') throw new HttpException('slow down', 429);
    }
  };
  const members = new SandboxMembersService(
    {
      sandboxPromptAuthor: { findUnique: async () => null, create: async () => ({}) }
    } as any,
    {} as any,
    { setCommentSink: () => {} } as any,
    undefined,
    rateLimit as any
  );
  await assert.rejects(
    members.recordPrompt({
      sandboxId: SANDBOX,
      userId: HOST,
      chatId: 'ses_a',
      messageId: newOpencodeMessageId(),
      directory: null
    }),
    (e: any) => e.getStatus() === 429
  );
  assert.deepEqual(checks, [`${HOST}:user:sandbox_prompt`]);
  const defined: Record<string, unknown> = {};
  new RateLimitService({
    define: (action: string, type: string, config: unknown) => {
      defined[`${action}_${type}`] = config;
    }
  } as any);
  assert.deepEqual(Object.keys(defined).sort(), [
    'sandbox_prompt_user',
    'sandbox_session_user',
    'sandbox_share_user'
  ]);
  assert.deepEqual(defined.sandbox_prompt_user, SANDBOX_RATE_LIMITS.sandbox_prompt);
  assert.deepEqual(defined.sandbox_session_user, {
    maxAttempts: 60,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  });
  const controller = new SandboxSessionsController(
    {
      requireSandboxRole: async () => ({ sandbox: { id: SANDBOX } })
    } as any,
    { create: async () => ({ id: 'created' }) } as any,
    {} as any,
    { findOrCreateByClerkId: async () => ({ id: HOST }) } as any,
    { configured: false } as any,
    {} as any,
    rateLimit as any
  );
  checks.length = 0;
  await controller.create({ user: { sub: HOST } }, SANDBOX, { repo: 'app' });
  assert.deepEqual(checks, [`${HOST}:user:sandbox_session`]);
});

test('whoever answers an agent permission or question is announced to the machine', async () => {
  const frames: Array<{ sandboxId: string; frame: Record<string, unknown> }> = [];
  const lookups: string[] = [];
  const members = new SandboxMembersService(
    {
      user: {
        findUnique: async ({ where }: any) => {
          lookups.push(where.id);
          return where.id === HOST
            ? { id: HOST, username: 'seb', firstName: 'Seb', lastName: null, imageUrl: null }
            : null;
        }
      }
    } as any,
    {} as any,
    {
      setCommentSink: () => {},
      broadcast: async (sandboxId: string, frame: Record<string, unknown>) => {
        frames.push({ sandboxId, frame });
      }
    } as any
  );
  await members.recordAnswer({
    sandboxId: SANDBOX,
    userId: HOST,
    requestId: 'per_abc',
    kind: 'permission'
  });
  assert.deepEqual(frames, [
    {
      sandboxId: SANDBOX,
      frame: {
        t: 'answer',
        user: { id: HOST, name: 'Seb', avatarUrl: null },
        requestId: 'per_abc',
        kind: 'permission'
      }
    }
  ]);
  await members.recordAnswer({
    sandboxId: SANDBOX,
    userId: 'gone',
    requestId: 'que_1',
    kind: 'question'
  });
  assert.equal(frames.length, 1);
  assert.deepEqual(lookups, [HOST, 'gone']);
});

test('a removed or downgraded guest loses the shells that hold their GitHub token', async () => {
  const guest = '33333333-3333-4333-8333-333333333333';
  const script = guestShellKillScript(guest);
  assert.match(script, /-u33333333333343338333333333333333\)/);
  assert.throws(() => guestShellKillScript('not-a-user'));
  const dir = mkdtempSync(join(tmpdir(), 'orchard-tmux-'));
  const fake = join(dir, 'tmux');
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = ls ]; then printf 'orchard-3f2d7e6a-0\\norchard-3f2d7e6a-0-u33333333333343338333333333333333\\norchard-3f2d7e6a-1-u44444444444444448444444444444444\\n'; exit 0; fi\necho "$@" >> ${dir}/killed\n`,
    { mode: 0o755 }
  );
  const run = spawnSync('/bin/sh', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin` } });
  assert.equal(run.status, 0);
  assert.equal(
    readFileSync(join(dir, 'killed'), 'utf8').trim(),
    'kill-session -t =orchard-3f2d7e6a-0-u33333333333343338333333333333333'
  );
  const execs: string[][] = [];
  const registry = {
    for: () => ({
      exec: async (_ref: any, command: string[]) => {
        execs.push(command);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      }
    })
  };
  await endGuestShells(registry as any, { id: SANDBOX, status: 'running' } as any, guest);
  assert.deepEqual(execs[0].slice(0, 4), ['su', '-l', 'dev', '-c']);
  assert.equal(execs[0][4], script);
  await endGuestShells(registry as any, { id: SANDBOX, status: 'stopped' } as any, guest);
  assert.equal(execs.length, 1);
});
