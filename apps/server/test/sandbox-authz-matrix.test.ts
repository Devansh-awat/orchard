import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SandboxAccessService,
  SandboxMinRole,
  SandboxRoleOptions,
  SandboxRoleResolution,
  sandboxRoleAllows
} from '../src/sandboxes/sandbox-access.service';
import { requestAuthStorage } from '../src/auth/request-context';
import { sandboxSshAccess } from '../src/sandboxes/sandbox-role-gate';
import { sshUpgradeSandboxId } from '../src/sandboxes/sandbox-ssh.gateway';
import { SandboxesController } from '../src/sandboxes/sandboxes.controller';
import { SandboxSessionsController } from '../src/sandboxes/sandbox-sessions.controller';
import { SandboxMembersController } from '../src/sandboxes/sandbox-members.controller';
import {
  LIVE_MESSAGE_ROLE,
  LIVE_MESSAGE_TYPES,
  liveRoleAllows
} from '../src/sandboxes/live/live-protocol';
import { opencodeMinRole } from '../src/sandboxes/sandbox-opencode-policy';

const SANDBOX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';

type Principal = 'host' | 'guest' | 'viewer' | 'orgAdmin' | 'otherOrg' | 'superadmin';

const PRINCIPALS: Record<Principal, SandboxRoleResolution> = {
  host: { role: 'owner', orgAdmin: false, superadmin: false },
  guest: { role: 'collaborator', orgAdmin: false, superadmin: false },
  viewer: { role: 'viewer', orgAdmin: false, superadmin: false },
  orgAdmin: { role: 'admin', orgAdmin: true, superadmin: false },
  otherOrg: { role: null, orgAdmin: false, superadmin: false },
  superadmin: { role: 'owner', orgAdmin: true, superadmin: true }
};

interface Gate {
  min: SandboxMinRole;
  orgAdmin?: boolean;
}

const SENTINEL = new Error('gate');

function recorder() {
  const calls: Gate[] = [];
  const access = {
    async requireSandboxRole(
      _id: string,
      _userId: string,
      min: SandboxMinRole,
      opts: SandboxRoleOptions = {}
    ) {
      calls.push({ min, ...(opts.orgAdmin ? { orgAdmin: true } : {}) });
      throw SENTINEL;
    }
  };
  const users = {
    async findOrCreateByClerkId() {
      return { id: 'u1', email: 'u1@example.com', username: 'u1', githubAccessToken: null };
    }
  };
  const analytics = { configured: false };
  return { calls, access, users, analytics };
}

function req(extra: Record<string, unknown> = {}) {
  return { user: { sub: 'u1', email: 'u1@example.com' }, query: {}, body: {}, ...extra };
}

async function gateOf(run: () => Promise<unknown>, calls: Gate[]): Promise<Gate | null> {
  calls.length = 0;
  await run().catch((e) => {
    if (e !== SENTINEL) throw e;
  });
  return calls[0] ?? null;
}

const any = undefined as any;

function sandboxesRoutes(
  c: SandboxesController
): Record<string, [Gate | null, () => Promise<unknown>]> {
  const oc = (method: string, path: string) =>
    c.opencodeProxy(
      req({ method, originalUrl: `/apiv1/sandboxes/${SANDBOX}/opencode/${path}` }),
      any,
      SANDBOX
    );
  return {
    'GET /sandboxes/:id/boot': [{ min: 'viewer' }, () => c.bootStatus(req(), SANDBOX)],
    'GET /sandboxes/:id/changes': [{ min: 'viewer' }, () => c.changes(req(), SANDBOX)],
    'GET /sandboxes/:id/diff': [{ min: 'viewer' }, () => c.diff(req(), SANDBOX)],
    'GET /sandboxes/:id/repos': [{ min: 'viewer' }, () => c.listRepos(req(), SANDBOX)],
    'POST /sandboxes/:id/repos': [{ min: 'owner' }, () => c.addRepo(req(), SANDBOX, {})],
    'GET /sandboxes/:id/conversations': [
      { min: 'viewer' },
      () => c.listConversations(req(), SANDBOX)
    ],
    'POST /sandboxes/:id/conversations': [
      { min: 'collaborator' },
      () => c.createConversation(req(), SANDBOX, {})
    ],
    'PATCH /sandboxes/:id/conversations/:cid': [
      { min: 'collaborator' },
      () => c.updateConversation(req(), SANDBOX, SID, {})
    ],
    'DELETE /sandboxes/:id/conversations/:cid': [
      { min: 'collaborator' },
      () => c.removeConversation(req(), SANDBOX, SID)
    ],
    'GET /sandboxes/:id/conversations/:cid/history': [
      { min: 'viewer' },
      () => c.conversationHistory(req(), SANDBOX, SID)
    ],
    'POST /sandboxes/:id/chat': [
      { min: 'collaborator' },
      () => c.chatStream(req(), any, SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/commit': [
      { min: 'collaborator' },
      () => c.gitCommit(req(), SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/uncommit': [
      { min: 'collaborator' },
      () => c.gitUncommit(req(), SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/push': [{ min: 'collaborator' }, () => c.gitPush(req(), SANDBOX, {})],
    'POST /sandboxes/:id/git/fetch': [
      { min: 'collaborator' },
      () => c.gitFetch(req(), SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/pull': [{ min: 'collaborator' }, () => c.gitPull(req(), SANDBOX, {})],
    'GET /sandboxes/:id/git/branches': [{ min: 'viewer' }, () => c.gitBranches(req(), SANDBOX)],
    'GET /sandboxes/:id/git/identity': [{ min: 'viewer' }, () => c.gitIdentity(req(), SANDBOX)],
    'POST /sandboxes/:id/git/checkout': [
      { min: 'collaborator' },
      () => c.gitCheckout(req(), SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/branch/delete (local)': [
      { min: 'collaborator' },
      () => c.gitDeleteBranch(req(), SANDBOX, {})
    ],
    'POST /sandboxes/:id/git/branch/delete (remote)': [
      { min: 'collaborator' },
      () => c.gitDeleteBranch(req(), SANDBOX, { remote: true })
    ],
    'POST /sandboxes/:id/git/pr': [{ min: 'collaborator' }, () => c.gitPr(req(), SANDBOX, {})],
    'GET /sandboxes/:id/file': [{ min: 'viewer' }, () => c.readFile(req(), SANDBOX)],
    'PUT /sandboxes/:id/file': [{ min: 'collaborator' }, () => c.writeFile(req(), SANDBOX, {})],
    'GET /sandboxes/:id/opencode/session/:id/message': [
      { min: 'viewer' },
      () => oc('GET', 'session/ses_abc/message')
    ],
    'POST /sandboxes/:id/opencode/session/:id/prompt_async': [
      { min: 'collaborator' },
      () => oc('POST', 'session/ses_abc/prompt_async')
    ],
    'PATCH /sandboxes/:id/opencode/config': [{ min: 'owner' }, () => oc('PATCH', 'config')],
    'PUT /sandboxes/:id/opencode/auth/anthropic': [
      { min: 'owner' },
      () => oc('PUT', 'auth/anthropic')
    ],
    'GET /sandboxes/:id/ssh': [{ min: 'owner' }, () => c.ssh(req(), SANDBOX)],
    'GET /sandboxes/:id/hostkey': [{ min: 'owner' }, () => c.hostKey(req(), SANDBOX)],
    'GET /sandboxes/:id/connect': [{ min: 'owner' }, () => c.connectInfo(req(), SANDBOX)],
    'GET /sandboxes/:id': [{ min: 'viewer' }, () => c.get(req(), SANDBOX)],
    'PATCH /sandboxes/:id': [{ min: 'owner' }, () => c.update(req(), SANDBOX, {})],
    'POST /sandboxes/:id/start': [
      { min: 'collaborator', orgAdmin: true },
      () => c.start(req(), SANDBOX)
    ],
    'POST /sandboxes/:id/stop': [{ min: 'owner', orgAdmin: true }, () => c.stop(req(), SANDBOX)],
    'POST /sandboxes/:id/apply/retry': [
      { min: 'owner', orgAdmin: true },
      () => c.retryApply(req(), SANDBOX)
    ],
    'DELETE /sandboxes/:id': [{ min: 'owner', orgAdmin: true }, () => c.remove(req(), SANDBOX)]
  };
}

function sessionRoutes(
  c: SandboxSessionsController
): Record<string, [Gate | null, () => Promise<unknown>]> {
  return {
    'GET /sandboxes/:id/sessions': [{ min: 'viewer' }, () => c.list(req(), SANDBOX)],
    'POST /sandboxes/:id/sessions': [{ min: 'collaborator' }, () => c.create(req(), SANDBOX, {})],
    'GET /sandboxes/:id/sessions/:sid': [{ min: 'viewer' }, () => c.get(req(), SANDBOX, SID)],
    'PATCH /sandboxes/:id/sessions/:sid': [
      { min: 'collaborator' },
      () => c.update(req(), SANDBOX, SID, { archived: true })
    ],
    'DELETE /sandboxes/:id/sessions/:sid': [
      { min: 'collaborator' },
      () => c.remove(req(), SANDBOX, SID)
    ],
    'DELETE /sandboxes/:id/sessions/:sid?deleteBranch=1': [
      { min: 'collaborator' },
      () => c.remove(req(), SANDBOX, SID, '1')
    ],
    'GET /sandboxes/:id/sessions/:sid/chats': [
      { min: 'viewer' },
      () => c.chats(req(), SANDBOX, SID)
    ],
    'POST /sandboxes/:id/sessions/:sid/chats': [
      { min: 'collaborator' },
      () => c.createChat(req(), SANDBOX, SID, {})
    ],
    'GET /sandboxes/:id/sessions/:sid/scripts': [
      { min: 'viewer' },
      () => c.scripts(req(), SANDBOX, SID)
    ],
    'POST /sandboxes/:id/sessions/:sid/run': [
      { min: 'collaborator' },
      () => c.run(req(), SANDBOX, SID, {})
    ],
    'GET /sandboxes/:id/sessions/:sid/ports': [
      { min: 'viewer' },
      () => c.ports(req(), SANDBOX, SID)
    ],
    'GET /sandboxes/:id/sessions/:sid/checks': [
      { min: 'viewer' },
      () => c.checks(req(), SANDBOX, SID)
    ],
    'POST /sandboxes/:id/sessions/:sid/git/merge': [
      { min: 'collaborator' },
      () => c.merge(req(), SANDBOX, SID, {})
    ],
    'POST /sandboxes/:id/fs/mkdir': [
      { min: 'collaborator' },
      () => c.mkdir(req(), SANDBOX, { path: 'a' })
    ],
    'POST /sandboxes/:id/fs/rename': [
      { min: 'collaborator' },
      () => c.rename(req(), SANDBOX, { path: 'a', to: 'b' })
    ],
    'POST /sandboxes/:id/fs/delete': [
      { min: 'collaborator' },
      () => c.deletePath(req(), SANDBOX, { path: 'a' })
    ]
  };
}

function memberRoutes(
  c: SandboxMembersController
): Record<string, [Gate | null, () => Promise<unknown>]> {
  return {
    'GET /sandboxes/:id/members': [{ min: 'viewer' }, () => c.list(req(), SANDBOX)],
    'POST /sandboxes/:id/members': [{ min: 'owner' }, () => c.add(req(), SANDBOX, {})],
    'PATCH /sandboxes/:id/members/:userId': [
      { min: 'owner' },
      () => c.update(req(), SANDBOX, MEMBER, {})
    ],
    'DELETE /sandboxes/:id/members/:userId': [
      { min: 'viewer' },
      () => c.remove(req(), SANDBOX, MEMBER)
    ],
    'GET /sandboxes/:id/sessions/:sid/comments': [
      { min: 'viewer' },
      () => c.comments(req(), SANDBOX, SID)
    ],
    'POST /sandboxes/:id/sessions/:sid/comments': [
      { min: 'collaborator' },
      () => c.comment(req(), SANDBOX, SID, {})
    ],
    'GET /sandboxes/:id/sessions/:sid/authors': [
      { min: 'viewer' },
      () => c.authors(req(), SANDBOX, SID)
    ],
    'GET /sandboxes/:id/preview-token': [
      { min: 'viewer' },
      () => c.previewToken(req(), SANDBOX, '3000')
    ]
  };
}

function allows(principal: Principal, gate: Gate): boolean {
  return sandboxRoleAllows(PRINCIPALS[principal], gate.min, { orgAdmin: gate.orgAdmin });
}

const EXPECTED: Record<string, Principal[]> = {
  viewer: ['host', 'guest', 'viewer', 'orgAdmin', 'superadmin'],
  collaborator: ['host', 'guest', 'superadmin'],
  'collaborator+orgAdmin': ['host', 'guest', 'orgAdmin', 'superadmin'],
  owner: ['host', 'superadmin'],
  'owner+orgAdmin': ['host', 'orgAdmin', 'superadmin']
};

function gateKey(gate: Gate): string {
  return gate.orgAdmin ? `${gate.min}+orgAdmin` : gate.min;
}

test('every principal gets exactly the access its role class allows', () => {
  for (const [key, allowed] of Object.entries(EXPECTED)) {
    const [min, extra] = key.split('+');
    const gate: Gate = { min: min as SandboxMinRole, orgAdmin: extra === 'orgAdmin' };
    for (const principal of Object.keys(PRINCIPALS) as Principal[]) {
      assert.equal(
        allows(principal, gate),
        allowed.includes(principal),
        `${principal} on a ${key} route`
      );
    }
  }
});

async function checkRoutes(
  routes: Record<string, [Gate | null, () => Promise<unknown>]>,
  calls: Gate[],
  methods: string[]
) {
  for (const [route, [expected, run]] of Object.entries(routes)) {
    const gate = await gateOf(run, calls);
    assert.deepEqual(gate, expected, route);
    const allowed = EXPECTED[gateKey(gate!)];
    assert.ok(allowed, `${route} has a known role class`);
  }
  assert.ok(methods.length > 0);
}

test('sandboxes controller routes declare the contract minimum role', async () => {
  const r = recorder();
  const c = new SandboxesController(
    any,
    any,
    any,
    any,
    r.users as any,
    r.analytics as any,
    any,
    any,
    r.access as any,
    any
  );
  await checkRoutes(
    sandboxesRoutes(c),
    r.calls,
    Object.getOwnPropertyNames(SandboxesController.prototype)
  );
  const covered = new Set([
    'constructor',
    'resolveUser',
    'list',
    'create',
    'getCredentials',
    'setCredentials',
    'bootStatus',
    'changes',
    'diff',
    'listRepos',
    'addRepo',
    'listConversations',
    'createConversation',
    'updateConversation',
    'removeConversation',
    'conversationHistory',
    'chatStream',
    'gitCommit',
    'gitUncommit',
    'gitPush',
    'gitFetch',
    'gitPull',
    'gitBranches',
    'gitIdentity',
    'gitCheckout',
    'gitDeleteBranch',
    'gitPr',
    'readFile',
    'writeFile',
    'opencodeProxy',
    'ssh',
    'hostKey',
    'connectInfo',
    'get',
    'update',
    'start',
    'stop',
    'retryApply',
    'remove'
  ]);
  for (const name of Object.getOwnPropertyNames(SandboxesController.prototype)) {
    assert.ok(covered.has(name), `SandboxesController.${name} is missing from the authz matrix`);
  }
});

test('session controller routes declare the contract minimum role', async () => {
  const r = recorder();
  const c = new SandboxSessionsController(
    r.access as any,
    any,
    any,
    r.users as any,
    r.analytics as any,
    any
  );
  await checkRoutes(
    sessionRoutes(c),
    r.calls,
    Object.getOwnPropertyNames(SandboxSessionsController.prototype)
  );
  const covered = new Set([
    'constructor',
    'resolveUser',
    'access',
    'fsOp',
    'list',
    'create',
    'get',
    'update',
    'remove',
    'chats',
    'createChat',
    'scripts',
    'run',
    'ports',
    'checks',
    'merge',
    'mkdir',
    'rename',
    'deletePath'
  ]);
  for (const name of Object.getOwnPropertyNames(SandboxSessionsController.prototype)) {
    assert.ok(
      covered.has(name),
      `SandboxSessionsController.${name} is missing from the authz matrix`
    );
  }
});

test('member, comment, author and preview routes declare the contract minimum role', async () => {
  const r = recorder();
  const c = new SandboxMembersController(
    r.access as any,
    any,
    any,
    r.users as any,
    r.analytics as any
  );
  await checkRoutes(
    memberRoutes(c),
    r.calls,
    Object.getOwnPropertyNames(SandboxMembersController.prototype)
  );
});

test('host-only and guest-level contract items hold for each principal', async () => {
  const r = recorder();
  const c = new SandboxesController(
    any,
    any,
    any,
    any,
    r.users as any,
    r.analytics as any,
    any,
    any,
    r.access as any,
    any
  );
  const routes = sandboxesRoutes(c);
  const check = async (route: string, principal: Principal, expected: boolean) => {
    const gate = await gateOf(routes[route][1], r.calls);
    assert.equal(allows(principal, gate!), expected, `${principal} ${route}`);
  };
  await check('POST /sandboxes/:id/start', 'guest', true);
  await check('POST /sandboxes/:id/start', 'viewer', false);
  await check('POST /sandboxes/:id/stop', 'guest', false);
  await check('POST /sandboxes/:id/stop', 'orgAdmin', true);
  await check('DELETE /sandboxes/:id', 'guest', false);
  await check('POST /sandboxes/:id/git/push', 'guest', true);
  await check('POST /sandboxes/:id/git/push', 'viewer', false);
  await check('POST /sandboxes/:id/git/push', 'orgAdmin', false);
  await check('POST /sandboxes/:id/git/pr', 'guest', true);
  await check('POST /sandboxes/:id/git/pr', 'orgAdmin', false);
  await check('POST /sandboxes/:id/git/branch/delete (remote)', 'guest', true);
  await check('POST /sandboxes/:id/git/branch/delete (remote)', 'viewer', false);
  await check('GET /sandboxes/:id/ssh', 'guest', false);
  await check('POST /sandboxes/:id/git/commit', 'guest', true);
  await check('POST /sandboxes/:id/git/commit', 'viewer', false);
  await check('PUT /sandboxes/:id/file', 'orgAdmin', false);
  await check('GET /sandboxes/:id/file', 'otherOrg', false);
  await check('POST /sandboxes/:id/opencode/session/:id/prompt_async', 'viewer', false);
  await check('PATCH /sandboxes/:id/opencode/config', 'guest', false);
});

test('live channel messages are enforced per role', () => {
  const writes = new Set(['draft', 'comment', 'yjs-save']);
  for (const type of LIVE_MESSAGE_TYPES) {
    const min = LIVE_MESSAGE_ROLE[type];
    assert.equal(min, writes.has(type) ? 'collaborator' : 'viewer', type);
    assert.equal(liveRoleAllows('viewer', min), !writes.has(type), `viewer ${type}`);
    assert.equal(liveRoleAllows('admin', min), !writes.has(type), `admin ${type}`);
    assert.equal(liveRoleAllows('collaborator', min), true, `guest ${type}`);
    assert.equal(liveRoleAllows('owner', min), true, `host ${type}`);
  }
});

test('opencode proxy paths map to the right minimum role', () => {
  const cases: Array<[string, string, SandboxMinRole]> = [
    ['GET', 'event', 'viewer'],
    ['GET', 'session', 'viewer'],
    ['GET', 'session/ses_a/message', 'viewer'],
    ['GET', 'session/ses_a/diff', 'viewer'],
    ['POST', 'session/ses_a/prompt_async', 'collaborator'],
    ['POST', 'session/ses_a/abort', 'collaborator'],
    ['POST', 'session', 'collaborator'],
    ['GET', 'file?path=x', 'collaborator'],
    ['GET', 'find/file?query=x', 'collaborator'],
    ['GET', 'config', 'collaborator'],
    ['PATCH', 'config', 'owner'],
    ['PUT', 'auth/anthropic', 'owner'],
    ['POST', 'mcp', 'owner'],
    ['GET', 'pty', 'owner'],
    ['POST', 'session/ses_a/share', 'owner'],
    ['GET', 'session/../config', 'owner'],
    ['GET', 'session/%2e%2e/config', 'owner'],
    ['GET', 'SESSION/ses_a/message', 'viewer'],
    ['PATCH', 'Config', 'owner'],
    ['GET', 'session%2fses_a', 'viewer'],
    ['GET', 'session/ses_a%00/message', 'owner']
  ];
  for (const [method, path, expected] of cases) {
    assert.equal(opencodeMinRole(method, path), expected, `${method} ${path}`);
  }
});

function accessService(opts: {
  ownerId?: string;
  superadmins?: string[];
  orgMembers?: Record<string, 'owner' | 'admin' | 'member' | 'guest'>;
  members?: Record<string, 'viewer' | 'collaborator'>;
}) {
  const sandbox = { id: SANDBOX, userId: opts.ownerId ?? 'host', organizationId: ORG };
  const prisma = {
    sandboxMember: {
      async findUnique({ where }: any) {
        const role = opts.members?.[where.sandboxId_userId.userId];
        return role ? { role } : null;
      }
    }
  };
  const authz = {
    async isSuperAdmin(userId: string) {
      return (opts.superadmins ?? []).includes(userId);
    },
    async getOrgAccess(organizationId: string, userId: string) {
      const ctx = requestAuthStorage.getStore();
      if (ctx?.sessionOrgId && ctx.sessionOrgId !== organizationId) return null;
      const role = opts.orgMembers?.[userId];
      if (!role || organizationId !== ORG) return null;
      return { organizationId, role, isAdmin: role === 'owner' || role === 'admin' };
    }
  };
  return { service: new SandboxAccessService(prisma as any, authz as any), sandbox };
}

test('sandbox roles resolve from ownership, membership and org admin rights', async () => {
  const { service, sandbox } = accessService({
    superadmins: ['root'],
    orgMembers: {
      host: 'member',
      guest: 'member',
      viewer: 'member',
      admin: 'admin',
      adminGuest: 'admin',
      plain: 'member'
    },
    members: {
      guest: 'collaborator',
      viewer: 'viewer',
      adminGuest: 'collaborator',
      exMember: 'collaborator'
    }
  });
  const role = async (userId: string) => (await service.sandboxRoleOf(sandbox, userId)).role;
  assert.equal(await role('host'), 'owner');
  assert.equal(await role('root'), 'owner');
  assert.equal(await role('guest'), 'collaborator');
  assert.equal(await role('viewer'), 'viewer');
  assert.equal(await role('admin'), 'admin');
  assert.equal(await role('adminGuest'), 'collaborator');
  assert.equal(await role('plain'), null, 'org members see nothing without an invite');
  assert.equal(await role('exMember'), null, 'a member who left the org loses the share');
  assert.equal(await role('stranger'), null);
  assert.equal(await role(''), null);
});

test('an org-scoped session or a project-scoped token reaches no other tenant sandbox', async () => {
  const { service, sandbox } = accessService({
    superadmins: ['root'],
    orgMembers: { host: 'member', guest: 'member' },
    members: { guest: 'collaborator' }
  });
  const scoped = (ctx: object, userId: string) =>
    requestAuthStorage.run(ctx, () => service.sandboxRoleOf(sandbox, userId));
  assert.equal((await scoped({ sessionOrgId: OTHER_ORG }, 'host')).role, null);
  assert.equal((await scoped({ sessionOrgId: OTHER_ORG }, 'root')).role, null);
  assert.equal((await scoped({ sessionOrgId: OTHER_ORG }, 'guest')).role, null);
  assert.equal((await scoped({ sessionOrgId: ORG }, 'guest')).role, 'collaborator');
  assert.equal((await scoped({ tokenProjectIds: ['p1'] }, 'host')).role, null);
});

test('ssh honours org-scoped sessions and refuses project-scoped tokens', async () => {
  const sandboxRow = {
    id: SANDBOX,
    userId: 'host',
    organizationId: ORG,
    status: 'running',
    sshIdentity: null,
    user: null
  };
  const prisma = {
    sandbox: { findUnique: async () => sandboxRow },
    sandboxMember: {
      async findUnique({ where }: any) {
        return where.sandboxId_userId.userId === 'guest' ? { role: 'collaborator' } : null;
      }
    }
  };
  const authz = {
    async isSuperAdmin(userId: string) {
      return userId === 'root';
    },
    async getOrgAccess(organizationId: string, userId: string) {
      const ctx = requestAuthStorage.getStore();
      if (ctx?.sessionOrgId && ctx.sessionOrgId !== organizationId) return null;
      if (!['host', 'guest', 'root'].includes(userId)) return null;
      return { organizationId, role: 'member', isAdmin: false };
    }
  };
  const service = new SandboxAccessService(prisma as any, authz as any);
  const ssh = (userId: string, scope: any = {}) =>
    sandboxSshAccess(service, SANDBOX, userId, scope).then((a) => a?.role ?? null);
  assert.equal(await ssh('host'), 'owner');
  assert.equal(await ssh('root'), 'owner');
  assert.equal(await ssh('guest'), null, 'ssh is host only');
  assert.equal(await ssh('host', { sessionOrgId: ORG }), 'owner');
  assert.equal(await ssh('host', { sessionOrgId: 'other-org' }), null, 'org-scoped session');
  assert.equal(await ssh('root', { sessionOrgId: 'other-org' }), null);
  assert.equal(await ssh('host', { tokenProjectIds: ['p1'] }), null, 'project-scoped token');
  assert.equal(await ssh('host', { tokenProjectIds: [] }), 'owner');
  assert.equal(requestAuthStorage.getStore(), undefined, 'scope does not leak');
});

test('upgrade handlers step aside for preview hosts', () => {
  const req = (url: string, host: string) => ({ url, headers: { host } }) as any;
  const skip = (r: any) => r.headers.host.endsWith('.preview.test');
  const id = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
  assert.equal(sshUpgradeSandboxId(req(`/apiv1/sandboxes/${id}/ssh`, 'orchard.test'), skip), id);
  assert.equal(
    sshUpgradeSandboxId(req(`/apiv1/sandboxes/${id}/ssh`, `3000-3f2d7e6a.preview.test`), skip),
    null
  );
  assert.equal(sshUpgradeSandboxId(req('/apiv1/other', 'orchard.test'), skip), null);
  assert.equal(
    sshUpgradeSandboxId(req(`/apiv1/sandboxes/${id}/ssh`, 'bad host with spaces'), skip),
    id,
    'a hostile Host header cannot crash the handler'
  );
});
