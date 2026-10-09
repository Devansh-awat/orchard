import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { requestAuthStorage } from '../src/auth/request-context';
import type { SandboxMinRole, SandboxRoleOptions } from '../src/sandboxes/sandbox-access.service';
import { SandboxAgentController } from '../src/sandboxes/sandbox-agent.controller';
import { SandboxForkController } from '../src/sandboxes/sandbox-fork.controller';
import {
  SandboxShareLinksController,
  SandboxShareViewerController,
  shareTokenFromHeader
} from '../src/sandboxes/sandbox-share-links.controller';
import { redactSensitivePath, redactSpanUrls } from '../src/analytics/url-redaction';
import {
  SandboxAgentService,
  transcriptLimit,
  transcriptMessages
} from '../src/sandboxes/sandbox-agent.service';
import {
  SandboxForkService,
  forkName,
  forkedSessionRows
} from '../src/sandboxes/sandbox-fork.service';
import {
  MAX_SHARE_HOURS,
  SHARE_TOKEN_RE,
  SandboxShareLinksService,
  hashShareToken,
  newShareToken,
  shareExpiry,
  shareLinkState,
  shareTokenMatches,
  shareUrl
} from '../src/sandboxes/sandbox-share-links.service';
import {
  FORK_UNSUPPORTED,
  KubernetesSandboxRunner,
  SANDBOX_OP_CR,
  SANDBOX_OP_FORK_CLEANUP,
  SANDBOX_OP_FORK_SNAPSHOT,
  SANDBOX_OP_SECRET,
  forkSnapshotOf,
  pickSnapshotClass
} from '../src/sandboxes/runners/kubernetes.runner';
import { VERCEL_OP_FORK, VercelSandboxRunner } from '../src/sandboxes/runners/vercel.runner';
import { forkSourceOf } from '../src/sandboxes/runners/sandbox-runner';
import { SandboxMirrorConsumer } from '../src/mirror/consumers/sandbox-mirror.consumer';
import { transitionWindowMs } from '../src/sandboxes/sandbox-reaper.service';

process.env.SECRETS_ENCRYPTION_KEY ||= 'test-secrets-key';

const SBX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const OWNER = '66666666-6666-4666-8666-666666666666';
const FORK = '77777777-7777-4777-8777-777777777777';

const SECRET_VALUES = ['ghp_fork_secret', 'sk-ant-fork-secret', 'sk-openai-fork', 'mcp-fork'];

const SECRETS = {
  authorizedKeys: ['ssh-ed25519 AAAA owner'],
  githubToken: 'ghp_fork_secret',
  claudeToken: 'sk-ant-fork-secret',
  openaiToken: 'sk-openai-fork',
  setupScript: null,
  mcpToken: 'mcp-fork',
  opencodePassword: 'pw',
  bridgeToken: 'bt'
};

const any = undefined as any;
const SENTINEL = new Error('gate');

function recorder() {
  const gates: Array<{ min: SandboxMinRole; orgAdmin?: boolean }> = [];
  const access = {
    async requireSandboxRole(
      _id: string,
      _u: string,
      min: SandboxMinRole,
      o: SandboxRoleOptions = {}
    ) {
      gates.push({ min, ...(o.orgAdmin ? { orgAdmin: true } : {}) });
      throw SENTINEL;
    }
  };
  const users = {
    async findOrCreateByClerkId() {
      return { id: OWNER, email: 'o@example.com', username: 'o', githubAccessToken: null };
    }
  };
  return { gates, access, users, analytics: { configured: false } };
}

async function gateOf(fn: () => Promise<unknown>, gates: any[]) {
  gates.length = 0;
  await fn().catch((e) => {
    if (e !== SENTINEL) throw e;
  });
  return gates[0] ?? null;
}

const req = () => ({ user: { sub: OWNER, email: 'o@example.com' }, query: {}, body: {} });

test('new sandbox routes declare their Host/Guest minimum role', async () => {
  const r = recorder();
  const agent = new SandboxAgentController(
    r.access as any,
    any,
    r.users as any,
    r.analytics as any,
    any
  );
  const fork = new SandboxForkController(r.access as any, any, r.users as any, r.analytics as any);
  const shares = new SandboxShareLinksController(
    r.access as any,
    any,
    r.users as any,
    r.analytics as any
  );
  const routes: Array<[string, () => Promise<unknown>, SandboxMinRole]> = [
    [
      'POST /sandboxes/:id/sessions/:sid/prompt',
      () => agent.prompt(req(), SBX, SID, {}),
      'collaborator'
    ],
    [
      'GET /sandboxes/:id/sessions/:sid/transcript',
      () => agent.transcript(req(), SBX, SID),
      'viewer'
    ],
    ['GET /sandboxes/:id/agent/usage', () => agent.usage(req(), SBX), 'collaborator'],
    ['POST /sandboxes/:id/fork', () => fork.fork(req(), SBX, {}), 'owner'],
    ['GET /sandboxes/:id/share-links', () => shares.list(req(), SBX), 'owner'],
    ['POST /sandboxes/:id/share-links', () => shares.create(req(), SBX, {}), 'owner'],
    ['DELETE /sandboxes/:id/share-links/:linkId', () => shares.revoke(req(), SBX, LINK), 'owner']
  ];
  for (const [route, fn, min] of routes) {
    assert.deepEqual(await gateOf(fn, r.gates), { min }, route);
  }
  const covered = new Set(['prompt', 'transcript', 'usage', 'fork', 'list', 'create', 'revoke']);
  for (const proto of [
    SandboxAgentController.prototype,
    SandboxForkController.prototype,
    SandboxShareLinksController.prototype
  ]) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      assert.ok(covered.has(name), `${name} is missing from the authz matrix`);
    }
  }
});

test('transcripts keep only human-visible text and the latest N messages', () => {
  const body = [
    {
      info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
      parts: [{ type: 'text', text: 'hi' }]
    },
    {
      info: { id: 'msg_2', role: 'assistant', time: { created: 2000 } },
      parts: [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool', tool: 'bash' },
        { type: 'text', text: 'done', synthetic: false },
        { type: 'text', text: 'internal', synthetic: true }
      ]
    },
    { info: { id: 'msg_3', role: 'system' }, parts: [{ type: 'text', text: 'no' }] },
    { info: { id: 'msg_4', role: 'user' }, parts: [{ type: 'text', text: 'x', ignored: true }] }
  ];
  const all = transcriptMessages(body, 10);
  assert.deepEqual(
    all.map((m) => [m.id, m.role, m.text]),
    [
      ['msg_1', 'user', 'hi'],
      ['msg_2', 'assistant', 'done']
    ]
  );
  assert.equal(all[0].createdAt, new Date(1000).toISOString());
  assert.deepEqual(
    transcriptMessages(body, 1).map((m) => m.id),
    ['msg_2']
  );
  assert.deepEqual(transcriptMessages({ not: 'a list' }, 5), []);
  assert.equal(transcriptLimit(undefined), 30);
  assert.equal(transcriptLimit('500'), 200);
  assert.equal(transcriptLimit('-3'), 30);
});

test('a prompt from MCP is attributed to the caller with the same message id opencode receives', async () => {
  const recorded: any[] = [];
  const requests: any[] = [];
  const session = {
    id: SID,
    sandboxId: SBX,
    title: 'Fix',
    slug: 'fix-abc',
    archivedAt: null,
    worktreePath: '/persist/home/.worktrees/app/fix-abc',
    opencodeSessionId: 'ses_abc123'
  };
  const workspace = {
    sessionRow: async () => session,
    opencodeRequest: async (_s: any, method: string, path: string, opts: any) => {
      requests.push({ method, path, opts });
      return { status: 204, body: null };
    }
  };
  const members = {
    recordPrompt: async (input: any) => {
      recorded.push(input);
      return true;
    }
  };
  const service = new SandboxAgentService({} as any, workspace as any, members as any);
  const sandbox = { id: SBX, status: 'running' } as any;
  const out = await service.prompt(sandbox, SID, 'mcp-user', 'please fix');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, 'mcp-user');
  assert.equal(recorded[0].chatId, 'ses_abc123');
  assert.equal(recorded[0].directory, session.worktreePath);
  assert.equal(requests[0].path, '/session/ses_abc123/prompt_async');
  assert.equal(requests[0].opts.body.messageID, recorded[0].messageId);
  assert.equal(out.messageId, recorded[0].messageId);
  await assert.rejects(service.prompt(sandbox, SID, 'u', ''), /text is required/);
  await assert.rejects(
    service.prompt({ id: SBX, status: 'stopped' } as any, SID, 'u', 'x'),
    /not running/
  );
  const refused = new SandboxAgentService(
    {} as any,
    workspace as any,
    { recordPrompt: async () => false } as any
  );
  await assert.rejects(refused.prompt(sandbox, SID, 'u', 'x'), /already in use/);
});

test('share tokens are 32 random bytes, stored only as a sha256 and compared in constant time', () => {
  const a = newShareToken();
  const b = newShareToken();
  assert.match(a.token, SHARE_TOKEN_RE);
  assert.equal(Buffer.from(a.token, 'base64url').length, 32);
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashShareToken(a.token));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.ok(!a.hash.includes(a.token));
  assert.equal(shareTokenMatches(a.token, a.hash), true);
  assert.equal(shareTokenMatches(b.token, a.hash), false);
  assert.equal(shareTokenMatches(a.token, ''), false);
});

test('share links expire and revoke', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(
    shareLinkState({ revokedAt: null, expiresAt: new Date('2026-10-09T00:00:00Z') }, now),
    'active'
  );
  assert.equal(shareLinkState({ revokedAt: null, expiresAt: now }, now), 'expired');
  assert.equal(
    shareLinkState({ revokedAt: now, expiresAt: new Date('2027-01-01') }, now),
    'revoked'
  );
  assert.equal(shareExpiry(undefined, now).toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(shareExpiry(2, now).toISOString(), '2026-10-08T14:00:00.000Z');
  assert.throws(() => shareExpiry(MAX_SHARE_HOURS + 1, now), /expiresInHours/);
  assert.throws(() => shareExpiry(0, now), /expiresInHours/);
  assert.throws(() => shareExpiry(1.5, now), /expiresInHours/);
});

function shareService(opts: {
  link?: Partial<Record<string, any>> | null;
  orgRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
  sessions?: any[];
}) {
  const token = newShareToken();
  const audits: any[] = [];
  const rateChecks: any[] = [];
  const workspaceCalls: any[] = [];
  const sandbox = {
    id: SBX,
    name: 'box',
    userId: OWNER,
    organizationId: ORG,
    status: 'running',
    desiredState: 'running'
  };
  const session = {
    id: SID,
    sandboxId: SBX,
    slug: 'fix',
    title: 'Fix',
    archivedAt: null,
    worktreePath: '/persist/home/.worktrees/app/fix'
  };
  const link =
    opts.link === null
      ? null
      : {
          id: LINK,
          sandboxId: SBX,
          sessionId: SID,
          createdById: OWNER,
          tokenHash: token.hash,
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          sandbox,
          session,
          createdBy: {
            id: OWNER,
            username: 'o',
            firstName: null,
            lastName: null,
            email: 'o@example.com',
            imageUrl: null
          },
          ...(opts.link ?? {})
        };
  const prisma = {
    sandboxShareLink: {
      findUnique: async ({ where }: any) =>
        link && where.tokenHash === link.tokenHash ? link : null,
      update: async () => link
    },
    sandboxConversation: {
      findFirst: async ({ where }: any) =>
        (opts.sessions ?? [session]).find(
          (s) => s.id === where.id && s.sandboxId === where.sandboxId
        ) ?? null,
      findMany: async () => opts.sessions ?? [session]
    }
  };
  const authz = {
    async getOrgAccess(orgId: string) {
      const ctx = requestAuthStorage.getStore();
      if (ctx?.sessionOrgId && ctx.sessionOrgId !== orgId) return null;
      if (orgId !== ORG || !opts.orgRole) return null;
      return { organizationId: orgId, role: opts.orgRole, isAdmin: opts.orgRole === 'admin' };
    }
  };
  const audit = { log: async (e: any) => audits.push(e) };
  const rateLimit = { checkRateLimit: async (...args: any[]) => rateChecks.push(args) };
  const workspace = {
    changes: async (s: any, sel: any) => {
      workspaceCalls.push(['changes', s.id, sel]);
      return { isRepo: true, branch: 'b', files: [] };
    },
    diff: async (s: any, file: any, sel: any) => {
      workspaceCalls.push(['diff', s.id, file, sel]);
      return { diff: '', truncated: false };
    }
  };
  const agent = {
    transcript: async (s: any, sid: string) => {
      workspaceCalls.push(['transcript', s.id, sid]);
      return { sessionId: sid, chatId: null, title: 't', messages: [] };
    }
  };
  const service = new SandboxShareLinksService(
    prisma as any,
    authz as any,
    audit as any,
    rateLimit as any,
    workspace as any,
    agent as any
  );
  return { service, token: token.token, audits, rateChecks, workspaceCalls };
}

const viewer = { id: 'teammate', email: 't@example.com' };

test('an org teammate can read the shared transcript and diff, nothing else', async () => {
  const s = shareService({ orgRole: 'member' });
  const view = await s.service.view(s.token, viewer);
  assert.equal(view.sandbox.id, SBX);
  assert.deepEqual(
    view.sessions.map((x: any) => x.id),
    [SID]
  );
  assert.ok(!('tokenHash' in view.link));
  await s.service.transcript(s.token, viewer, SID, '10');
  await s.service.changes(s.token, viewer, SID);
  await s.service.diff(s.token, viewer, SID, 'a.ts');
  assert.deepEqual(s.workspaceCalls, [
    ['transcript', SBX, SID],
    ['changes', SBX, { session: SID }],
    ['diff', SBX, 'a.ts', { session: SID }]
  ]);
  assert.ok(
    s.rateChecks.every(
      ([id, type, action]) => id === 'teammate' && type === 'user' && action === 'sandbox_share'
    )
  );
  assert.equal(s.rateChecks.length, 4);
  const uses = s.audits.filter((a) => a.action === 'sandbox.share_link.use');
  assert.equal(uses.length, 1, 'repeated reads inside the window are audited once');
  assert.equal(uses[0].actorUserId, 'teammate');
});

test('a session link never opens another session of the same machine', async () => {
  const other = '88888888-8888-4888-8888-888888888888';
  const s = shareService({ orgRole: 'member' });
  await assert.rejects(s.service.transcript(s.token, viewer, other), /Session not found/);
  await assert.rejects(s.service.diff(s.token, viewer, other), /Session not found/);
});

test('share links fail closed: unknown, malformed, expired, revoked, deleted', async () => {
  const unknown = shareService({ orgRole: 'member', link: null });
  await assert.rejects(unknown.service.view(unknown.token, viewer), /invalid, expired or revoked/);
  await assert.rejects(unknown.service.view('short', viewer), /invalid, expired or revoked/);
  await assert.rejects(
    unknown.service.view('../../etc/passwd', viewer),
    /invalid, expired or revoked/
  );
  const expired = shareService({
    orgRole: 'member',
    link: { expiresAt: new Date(Date.now() - 1) }
  });
  await assert.rejects(expired.service.view(expired.token, viewer), /invalid, expired or revoked/);
  const revoked = shareService({ orgRole: 'member', link: { revokedAt: new Date() } });
  await assert.rejects(revoked.service.view(revoked.token, viewer), /invalid, expired or revoked/);
  const deleted = shareService({
    orgRole: 'member',
    link: {
      sandbox: {
        id: SBX,
        name: 'b',
        organizationId: ORG,
        desiredState: 'deleted',
        status: 'deleting'
      }
    }
  });
  await assert.rejects(deleted.service.view(deleted.token, viewer), /invalid, expired or revoked/);
  for (const svc of [unknown, expired, revoked, deleted]) {
    assert.equal(svc.audits.length, 0, 'a refused link is never recorded as used');
  }
});

test('only members of the machine organization can open a share link', async () => {
  const outsider = shareService({ orgRole: null });
  await assert.rejects(outsider.service.view(outsider.token, viewer), /members of the machine/);
  const guest = shareService({ orgRole: 'guest' });
  await assert.rejects(guest.service.view(guest.token, viewer), /members of the machine/);
  const scoped = shareService({ orgRole: 'member' });
  await assert.rejects(
    requestAuthStorage.run({ sessionOrgId: OTHER_ORG }, () =>
      scoped.service.view(scoped.token, viewer)
    ),
    /members of the machine/
  );
  await assert.rejects(
    requestAuthStorage.run({ tokenProjectIds: ['p1'] }, () =>
      scoped.service.view(scoped.token, viewer)
    ),
    /members of the machine/
  );
  const ok = await requestAuthStorage.run({ sessionOrgId: ORG }, () =>
    scoped.service.view(scoped.token, viewer)
  );
  assert.equal(ok.sandbox.id, SBX);
});

test('share viewer routes all resolve the token before touching the machine', async () => {
  const calls: string[] = [];
  const shares = {
    view: async () => calls.push('view'),
    transcript: async () => calls.push('transcript'),
    changes: async () => calls.push('changes'),
    diff: async () => calls.push('diff')
  };
  const users = {
    async findOrCreateByClerkId() {
      return { id: 'teammate', email: 't@example.com' };
    }
  };
  const c = new SandboxShareViewerController(
    shares as any,
    users as any,
    { configured: false } as any
  );
  await c.view(req(), 'tok');
  await c.transcript(req(), 'tok', SID);
  await c.changes(req(), 'tok', SID);
  await c.diff(req(), 'tok', SID);
  assert.deepEqual(calls, ['view', 'transcript', 'changes', 'diff']);
  const methods = Object.getOwnPropertyNames(SandboxShareViewerController.prototype).filter(
    (n) => n !== 'constructor' && n !== 'viewer'
  );
  assert.deepEqual(methods.sort(), [
    'changes',
    'changesByHeader',
    'diff',
    'diffByHeader',
    'transcript',
    'transcriptByHeader',
    'view',
    'viewByHeader'
  ]);
});

function forkHarness(opts: {
  fork?: boolean;
  forkSupport?: string | null;
  cap?: number | null;
  count?: number;
  enabled?: boolean;
  callerId?: string;
  canCreate?: boolean;
}) {
  const created: any[] = [];
  const sessionCopies: any[] = [];
  const audits: any[] = [];
  const forks: any[] = [];
  const source = {
    id: SBX,
    userId: OWNER,
    organizationId: ORG,
    name: 'box',
    runner: 'kubernetes',
    podName: `sbx-${SBX}`,
    namespace: 'orchard-sandboxes',
    externalId: null,
    runnerState: { secretHash: 'h' },
    status: 'running',
    desiredState: 'running',
    image: 'img',
    repoUrl: null,
    sshIdentityId: 'ident',
    setupScript: null,
    cpuLimit: '2',
    memoryLimit: '4Gi',
    diskSize: '10Gi'
  };
  const tx = {
    sandbox: {
      create: async ({ data }: any) => {
        created.push(data);
        return {
          ...data,
          sshIdentity: null,
          user: null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }
    },
    sandboxConversation: {
      createMany: async ({ data }: any) => {
        sessionCopies.push(...data);
        return { count: data.length };
      }
    }
  };
  const prisma = {
    sandbox: {
      count: async () => opts.count ?? 0,
      findUnique: async () => null,
      update: async ({ data }: any) => ({ ...created[0], ...data })
    },
    sandboxConversation: {
      findMany: async () => [
        {
          title: 'Fix',
          repo: 'app',
          slug: 'fix-1',
          branch: 'orchard/fix-1',
          baseBranch: 'main',
          baseCommit: 'abc',
          worktreePath: '/persist/home/.worktrees/app/fix-1',
          agent: 'opencode',
          createdById: OWNER
        }
      ]
    },
    $transaction: async (fn: any) => fn(tx)
  };
  const runner = {
    id: 'kubernetes',
    label: 'Kubernetes',
    namespace: 'orchard-sandboxes',
    capabilities: { fork: opts.fork ?? true },
    configError: () => null,
    forkSupport: async () => opts.forkSupport ?? null,
    requestFork: async (src: any, target: any, by: any) => forks.push({ src, target, by })
  };
  const registry = { for: () => runner, enabled: () => opts.enabled ?? true };
  const sandboxes = {
    requireCanCreateIn: async () => {
      if (opts.canCreate === false) throw new ForbiddenException('Guests cannot create sandboxes');
    },
    sandboxCap: async () => (opts.cap === undefined ? 3 : opts.cap),
    dto: async (row: any) => ({ id: row.id, name: row.name, status: row.status })
  };
  const service = new SandboxForkService(
    prisma as any,
    registry as any,
    sandboxes as any,
    { log: async (e: any) => audits.push(e) } as any
  );
  const access = {
    sandbox: source,
    userId: opts.callerId ?? OWNER,
    role: 'owner',
    orgAdmin: false,
    superadmin: (opts.callerId ?? OWNER) !== OWNER
  } as any;
  return { service, access, created, sessionCopies, audits, forks };
}

test('forking is capability gated with a clear 409', async () => {
  const off = forkHarness({ fork: false });
  await assert.rejects(off.service.fork(off.access, null, {}), (e: any) => {
    assert.equal(e.getStatus(), 409);
    assert.match(e.message, /Forking is not available/);
    return true;
  });
  const noClass = forkHarness({ forkSupport: FORK_UNSUPPORTED });
  await assert.rejects(noClass.service.fork(noClass.access, null, {}), (e: any) => {
    assert.equal(e.getStatus(), 409);
    assert.match(e.message, /VolumeSnapshotClass/);
    return true;
  });
  const disabled = forkHarness({ enabled: false });
  await assert.rejects(disabled.service.fork(disabled.access, null, {}), /turned off/);
  for (const h of [off, noClass, disabled]) assert.equal(h.created.length, 0);
});

test('a fork respects the per-user cap and is refused to anyone but the real owner', async () => {
  const full = forkHarness({ cap: 1, count: 1 });
  await assert.rejects(full.service.fork(full.access, null, {}), /Sandbox limit reached/);
  const admin = forkHarness({ callerId: 'superadmin' });
  await assert.rejects(admin.service.fork(admin.access, null, {}), /Only the machine's owner/);
  const demoted = forkHarness({ canCreate: false });
  await assert.rejects(demoted.service.fork(demoted.access, null, {}), /Guests cannot create/);
  assert.equal(full.created.length + admin.created.length + demoted.created.length, 0);
});

test('a fork copies the machine row and its sessions, minus agent chat ids, and queues ids only', async () => {
  const h = forkHarness({});
  const dto = await h.service.fork(h.access, 'o@example.com', { name: 'box-copy' });
  assert.equal(dto.myRole, 'owner');
  const row = h.created[0];
  assert.equal(row.userId, OWNER);
  assert.equal(row.organizationId, ORG);
  assert.equal(row.name, 'box-copy');
  assert.equal(row.podName, `sbx-${row.id}`);
  assert.deepEqual(forkSourceOf(row.runnerState), { sandboxId: SBX, podName: `sbx-${SBX}` });
  assert.equal(row.runnerState.secretHash, undefined, 'runner state is not inherited');
  assert.equal(h.sessionCopies.length, 1);
  assert.equal(h.sessionCopies[0].sandboxId, row.id);
  assert.equal(h.sessionCopies[0].branch, 'orchard/fix-1');
  assert.ok(!('opencodeSessionId' in h.sessionCopies[0]));
  assert.ok(!('prUrl' in h.sessionCopies[0]));
  assert.equal(h.forks.length, 1);
  assert.equal(h.forks[0].src.id, SBX);
  assert.equal(h.forks[0].target.id, row.id);
  assert.equal(h.audits[0].action, 'sandbox.fork');
  assert.equal(h.audits[0].metadata.sourceSandboxId, SBX);
  assert.equal(forkName('a'.repeat(63), ''), `${'a'.repeat(58)}-fork`);
  assert.equal(forkName('box', '-ab12'), 'box-fork-ab12');
  assert.deepEqual(forkedSessionRows([{ slug: null } as any], FORK), []);
});

function k8sRunner(
  row: Record<string, any>,
  k8s: { claim?: any; classes?: any[]; provisioner?: string }
) {
  const enqueued: any[] = [];
  const applied: any[] = [];
  const updates: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  let current = { ...row };
  const prisma = {
    sandbox: {
      findUnique: async () => current,
      updateMany: async (args: any) => {
        updates.push(args);
        current = { ...current, ...args.data };
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
        return { ...manifest, status: {} };
      }
    } as never,
    { forSandbox: async () => SECRETS } as never
  );
  (runner as any).homeClaim = async () => k8s.claim ?? null;
  (runner as any).existingCr = async () => null;
  runner.snapshotClassFor = async () =>
    k8s.classes ? pickSnapshotClass(k8s.classes, k8s.provisioner ?? 'rbd.csi.ceph.com') : null;
  return { runner, enqueued, applied, updates, handlers, current: () => current };
}

const FORK_ROW = {
  id: FORK,
  userId: OWNER,
  runner: 'kubernetes',
  podName: `sbx-${FORK}`,
  namespace: 'orchard-sandboxes',
  externalId: null,
  runnerState: { forkFrom: { sandboxId: SBX, podName: `sbx-${SBX}` } },
  status: 'creating',
  desiredState: 'running',
  repoUrl: null,
  image: 'img',
  cpuLimit: '2',
  memoryLimit: '4Gi',
  diskSize: '10Gi',
  setupScript: null
};

function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRET_VALUES)
    assert.ok(!text.includes(secret), `queue row leaks ${secret}`);
}

test('kubernetes fork queues a snapshot op carrying ids only', async () => {
  const k = k8sRunner(FORK_ROW, {});
  await k.runner.requestFork(
    { ...FORK_ROW, id: SBX, podName: `sbx-${SBX}`, runnerState: null } as any,
    FORK_ROW as any,
    OWNER
  );
  const fork = k.enqueued.find((e) => e.opType === SANDBOX_OP_FORK_SNAPSHOT);
  assert.deepEqual(fork.manifest, { sandboxId: FORK, sourceSandboxId: SBX });
  assert.ok(k.enqueued.some((e) => e.opType === SANDBOX_OP_SECRET));
  noSecrets(k.enqueued);
});

test('kubernetes fork without a matching VolumeSnapshotClass fails terminally and marks the row', async () => {
  const k = k8sRunner(FORK_ROW, {
    claim: { metadata: { name: `home-sbx-${SBX}` }, spec: { storageClassName: 'local-path' } },
    classes: [{ metadata: { name: 'other' }, driver: 'ebs.csi.aws.com' }]
  });
  await assert.rejects(
    k.handlers.get(SANDBOX_OP_FORK_SNAPSHOT)!({
      dedupeKey: 'x',
      opType: SANDBOX_OP_FORK_SNAPSHOT,
      manifest: { sandboxId: FORK, sourceSandboxId: SBX },
      deploymentId: null
    }),
    (e: any) => e.getStatus?.() === 400 && /VolumeSnapshotClass/.test(e.message)
  );
  assert.equal(k.current().status, 'error');
  assert.equal(k.applied.length, 0);
});

test('kubernetes fork snapshots the source home, then restores the new CR from it', async () => {
  const prevRuntime = process.env.SANDBOX_RUNTIME_CLASS;
  process.env.SANDBOX_RUNTIME_CLASS = 'kata';
  try {
    const k = k8sRunner(FORK_ROW, {
      claim: {
        metadata: { name: `home-sbx-${SBX}` },
        spec: { storageClassName: 'ceph-block', volumeMode: 'Block' }
      },
      classes: [
        { metadata: { name: 'ceph-snap' }, driver: 'rbd.csi.ceph.com' },
        {
          metadata: {
            name: 'ceph-default',
            annotations: { 'snapshot.storage.kubernetes.io/is-default-class': 'true' }
          },
          driver: 'rbd.csi.ceph.com'
        }
      ]
    });
    const cr = k.handlers.get(SANDBOX_OP_CR)!;
    await cr({
      dedupeKey: 'c',
      opType: SANDBOX_OP_CR,
      manifest: { sandboxId: FORK },
      deploymentId: null
    });
    assert.equal(k.applied.length, 0, 'the CR waits for the snapshot');
    await k.handlers.get(SANDBOX_OP_FORK_SNAPSHOT)!({
      dedupeKey: 'x',
      opType: SANDBOX_OP_FORK_SNAPSHOT,
      manifest: { sandboxId: FORK, sourceSandboxId: SBX },
      deploymentId: null
    });
    const snapshot = k.applied[0];
    assert.equal(snapshot.kind, 'VolumeSnapshot');
    assert.equal(snapshot.spec.volumeSnapshotClassName, 'ceph-default');
    assert.equal(snapshot.spec.source.persistentVolumeClaimName, `home-sbx-${SBX}`);
    assert.equal(snapshot.metadata.labels['orchard.my/sandbox-id'], FORK);
    assert.deepEqual(forkSnapshotOf(k.current().runnerState), {
      name: `sbx-${FORK}-fork`,
      volumeMode: 'Block',
      storageClassName: 'ceph-block'
    });
    assert.ok(k.enqueued.some((e) => e.opType === SANDBOX_OP_CR && e.manifest.sandboxId === FORK));
    await cr({
      dedupeKey: 'c',
      opType: SANDBOX_OP_CR,
      manifest: { sandboxId: FORK },
      deploymentId: null
    });
    const applied = k.applied[1];
    assert.equal(applied.kind, 'Sandbox');
    const claim = applied.spec.volumeClaimTemplates[0];
    assert.deepEqual(claim.spec.dataSource, {
      apiGroup: 'snapshot.storage.k8s.io',
      kind: 'VolumeSnapshot',
      name: `sbx-${FORK}-fork`
    });
    assert.equal(claim.spec.volumeMode, 'Block');
    assert.equal(claim.spec.storageClassName, 'ceph-block');
    assert.equal(claim.spec.resources.requests.storage, '10Gi');
    noSecrets(k.applied);
    noSecrets(k.enqueued);
  } finally {
    if (prevRuntime === undefined) delete process.env.SANDBOX_RUNTIME_CLASS;
    else process.env.SANDBOX_RUNTIME_CLASS = prevRuntime;
  }
});

test('a plain sandbox CR never carries a snapshot data source', () => {
  const k = k8sRunner({ ...FORK_ROW, runnerState: null }, {});
  const cr = k.runner.buildCr({ ...FORK_ROW, runnerState: null } as any, 'inst-1', null);
  assert.equal(cr.spec.volumeClaimTemplates[0].spec.dataSource, undefined);
  assert.equal(pickSnapshotClass([], 'x'), null);
});

test('vercel fork goes through the queue with ids only and forks instead of creating', async () => {
  const enqueued: any[] = [];
  const handlers = new Map<string, (item: any) => Promise<void>>();
  const forked: any[] = [];
  let row: any = {
    ...FORK_ROW,
    runner: 'vercel',
    namespace: null,
    runnerState: { forkFrom: { sandboxId: SBX, podName: `sbx-${SBX}` } }
  };
  const prisma = {
    sandbox: {
      findUnique: async () => row,
      updateMany: async (args: any) => {
        row = { ...row, ...args.data };
        return { count: 1 };
      }
    }
  };
  const values: Record<string, string> = {
    vercelToken: 'vercel-api-token',
    vercelTeamId: 'team_1',
    vercelProjectId: 'prj_1'
  };
  const runner = new VercelSandboxRunner(
    prisma as never,
    { generation: 1, value: (_s: unknown, name: string) => values[name] ?? null } as never,
    { get: async () => 'inst-1', createIfAbsent: async () => true } as never,
    { enqueue: async (input: any) => enqueued.push(input) } as never,
    { registerHandler: (op: string, fn: any) => handlers.set(op, fn) } as never,
    { forSandbox: async () => SECRETS } as never
  );
  const session = {
    domain: (port: number) => `https://${port}-box.vercel.run`,
    runCommand: async () => ({
      exitCode: 0,
      wait: async () => ({ exitCode: 0 }),
      stdout: async () => '',
      stderr: async () => '',
      logs: () => ({ async *[Symbol.asyncIterator]() {} }),
      kill: async () => {}
    }),
    writeFiles: async () => {},
    readFileToBuffer: async () => null,
    extendTimeout: async () => {}
  };
  const box = {
    name: `sbx-${FORK}`,
    status: 'running',
    currentSession: () => session,
    stop: async () => ({}),
    delete: async () => {},
    update: async () => {}
  };
  const drives: any[] = [];
  runner.sdk = {
    get: async (params: any) => {
      if (params.name === `sbx-${SBX}` && !params.resume) {
        return { ...box, name: params.name, status: 'stopped', region: 'iad1' } as never;
      }
      throw Object.assign(new Error('nf'), { response: { status: 404 } });
    },
    create: async () => {
      throw new Error('a fork must not create a blank box');
    },
    fork: async (params: any) => {
      forked.push(params);
      return box as never;
    },
    getDrive: async () => {
      throw Object.assign(new Error('nf'), { response: { status: 404 } });
    },
    getOrCreateDrive: async (params: any) => {
      drives.push(params);
      return { name: params.name, region: params.region } as never;
    },
    driveForksAvailable: async () => true
  };
  runner.bootPollMs = 1;
  await runner.requestFork(
    { id: SBX, podName: `sbx-${SBX}` } as any,
    { id: FORK, podName: `sbx-${FORK}` } as any,
    OWNER
  );
  assert.equal(enqueued[0].opType, VERCEL_OP_FORK);
  assert.deepEqual(enqueued[0].manifest, { sandboxId: FORK, sourceSandboxId: SBX });
  noSecrets(enqueued);
  (runner as any).pushInit = async () => {};
  await handlers.get(VERCEL_OP_FORK)!({
    dedupeKey: 'v',
    opType: VERCEL_OP_FORK,
    manifest: enqueued[0].manifest,
    deploymentId: null
  });
  assert.equal(forked.length, 1);
  assert.equal(forked[0].sourceSandbox, `sbx-${SBX}`);
  assert.equal(forked[0].name, `sbx-${FORK}`);
  assert.equal(forked[0].tags.orchard_sandbox, FORK);
  assert.equal(forked[0].tags.orchard_user, OWNER);
  assert.ok(forked[0].networkPolicy, 'the network policy is set for the new owner, not inherited');
  assert.equal(drives[0].name, `orchard-${FORK}`);
  assert.equal(forked[0].mounts['/mnt/orchard-drive'].drive, `orchard-${FORK}`);
  assert.equal(forked[0].snapshotExpiration, 0);
  assert.ok(row.runnerState.forkedAt, 'a later re-provision creates instead of re-forking');
  assert.equal(row.status, 'running');
});

test('the fork snapshot is deleted once the restored claim is bound and the machine runs', async () => {
  const snapshotState = {
    forkFrom: { sandboxId: SBX, podName: `sbx-${SBX}` },
    forkSnapshot: { name: `sbx-${FORK}-fork`, volumeMode: 'Block', storageClassName: 'ceph' },
    secretHash: 'h'
  };
  const k = k8sRunner(
    { ...FORK_ROW, status: 'running', runnerState: snapshotState },
    { claim: { metadata: { name: `home-sbx-${FORK}` }, status: { phase: 'Pending' } } }
  );
  const deleted: string[] = [];
  (k.runner as any).custom = () => ({
    deleteNamespacedCustomObject: async (...args: any[]) => {
      deleted.push(args[4]);
      return {};
    }
  });
  (k.runner as any).queue.hasOpenItem = async () => false;
  await k.runner.requestForkCleanup(FORK);
  const op = k.enqueued.find((e) => e.opType === SANDBOX_OP_FORK_CLEANUP);
  assert.deepEqual(op.manifest, { sandboxId: FORK });
  assert.equal(op.dedupeKey, `sandbox:${FORK}:fork-cleanup`);
  const cleanup = k.handlers.get(SANDBOX_OP_FORK_CLEANUP)!;
  const item = { dedupeKey: op.dedupeKey, opType: op.opType, manifest: op.manifest };
  await cleanup(item);
  assert.deepEqual(deleted, [], 'pending claim keeps the snapshot');
  (k.runner as any).homeClaim = async () => ({
    metadata: { name: `home-sbx-${FORK}` },
    status: { phase: 'Bound' }
  });
  await cleanup(item);
  assert.deepEqual(deleted, [`sbx-${FORK}-fork`]);
  const state = k.current().runnerState;
  assert.equal(state.forkSnapshot, undefined);
  assert.equal(state.forkFrom, undefined);
  assert.equal(state.secretHash, 'h');
  await cleanup(item);
  assert.equal(deleted.length, 1, 'nothing left to clean');
});

test('the mirror asks for fork cleanup when the restored claim binds', async () => {
  const asked: string[] = [];
  let row: any = {
    runner: 'kubernetes',
    status: 'running',
    runnerState: { forkSnapshot: { name: 'x-fork' } }
  };
  const consumer = new SandboxMirrorConsumer(
    { sandbox: { findUnique: async () => row } } as never,
    { requestForkCleanup: async (id: string) => asked.push(id) } as never,
    {} as never
  );
  const claim = (phase: string) => ({
    metadata: { labels: { 'orchard.my/sandbox-id': FORK } },
    status: { phase }
  });
  await consumer.onClaimEvent('update', claim('Pending'));
  await consumer.onClaimEvent('delete', claim('Bound'));
  assert.deepEqual(asked, []);
  await consumer.onClaimEvent('update', claim('Bound'));
  assert.deepEqual(asked, [FORK]);
  row = { ...row, runnerState: {} };
  await consumer.onClaimEvent('update', claim('Bound'));
  assert.deepEqual(asked, [FORK]);
});

test('a machine being forked gets thirty minutes before the reaper calls it stuck', () => {
  assert.equal(transitionWindowMs({ forkFrom: { sandboxId: SBX, podName: 'p' } }), 30 * 60 * 1000);
  assert.equal(transitionWindowMs(null), 10 * 60 * 1000);
  assert.equal(transitionWindowMs({ secretHash: 'h' }), 10 * 60 * 1000);
});

test('share viewer routes take the token from X-Orchard-Share-Token', async () => {
  assert.equal(shareTokenFromHeader({ headers: { 'x-orchard-share-token': ' tok ' } }), 'tok');
  assert.equal(shareTokenFromHeader({ headers: { 'x-orchard-share-token': ['a', 'b'] } }), 'a');
  assert.throws(() => shareTokenFromHeader({ headers: {} }), /X-Orchard-Share-Token/);
  assert.throws(
    () => shareTokenFromHeader({ headers: { 'x-orchard-share-token': '  ' } }),
    /X-Orchard-Share-Token/
  );
  const seen: any[] = [];
  const shares = {
    view: async (token: string) => seen.push(['view', token]),
    transcript: async (token: string, _u: unknown, sid: string, limit?: string) =>
      seen.push(['transcript', token, sid, limit]),
    changes: async (token: string, _u: unknown, sid: string) => seen.push(['changes', token, sid]),
    diff: async (token: string, _u: unknown, sid: string, file?: string) =>
      seen.push(['diff', token, sid, file])
  };
  const viewer = new SandboxShareViewerController(shares as never, {} as never, {} as never);
  (viewer as any).viewer = async () => ({ id: OWNER, email: null });
  const req = { headers: { 'x-orchard-share-token': 'tok_1' } };
  await viewer.viewByHeader(req);
  await viewer.transcriptByHeader(req, SID, '5');
  await viewer.changesByHeader(req, SID);
  await viewer.diffByHeader(req, SID, 'a.ts');
  await viewer.view(req, 'path_tok');
  assert.deepEqual(seen, [
    ['view', 'tok_1'],
    ['transcript', 'tok_1', SID, '5'],
    ['changes', 'tok_1', SID],
    ['diff', 'tok_1', SID, 'a.ts'],
    ['view', 'path_tok']
  ]);
  assert.match(shareUrl('abc'), /\/share\/sandbox#abc$/);
});

test('share tokens are redacted from traced and reported urls', () => {
  assert.equal(
    redactSensitivePath('https://o.example/apiv1/share/sandbox/AbC_-123/sessions/x/diff?file=a'),
    'https://o.example/apiv1/share/sandbox/[redacted]/sessions/x/diff?file=a'
  );
  assert.equal(redactSensitivePath('/apiv1/share/sandbox/tok'), '/apiv1/share/sandbox/[redacted]');
  assert.equal(
    redactSensitivePath('/apiv1/share/sandbox/sessions/abc/transcript'),
    '/apiv1/share/sandbox/sessions/abc/transcript'
  );
  assert.equal(redactSensitivePath('/apiv1/sandboxes/x'), '/apiv1/sandboxes/x');
  const tags: Record<string, unknown> = {
    'http.url': 'https://o.example/apiv1/share/sandbox/secret-token',
    'http.endpoint': '/apiv1/share/sandbox/secret-token'
  };
  redactSpanUrls({
    context: () => ({ getTag: (k: string) => tags[k] }),
    setTag: (k: string, v: unknown) => {
      tags[k] = v;
    }
  });
  assert.ok(!JSON.stringify(tags).includes('secret-token'));
});
