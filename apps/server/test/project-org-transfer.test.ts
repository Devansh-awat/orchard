import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectOrgTransferService } from '../src/projects/project-org-transfer.service';
import { AuthorizationService } from '../src/auth/authorization.service';
import { requestAuthStorage, type RequestAuthContext } from '../src/auth/request-context';

type OrgRole = 'owner' | 'admin' | 'member' | 'guest';

type State = {
  orgs: Record<string, any>;
  users: Record<string, any>;
  orgMembers: { organizationId: string; userId: string; role: OrgRole; status: string }[];
  roles: { id: string; name: string }[];
  projects: Record<string, any>;
  projectMembers: { id: string; projectId: string; userId: string; roleId: string }[];
  invitations: { id: string; projectId: string }[];
  channels: { id: string; organizationId: string; scopeType: string; scopeId: string | null }[];
  rules: { id: string; organizationId: string; scopeType: string; scopeId: string | null }[];
  environments: { projectId: string; namespace: string }[];
  deployments: any[];
  databases: any[];
};

const ROLE = { admin: 'r-admin', member: 'r-member', viewer: 'r-viewer' };

function seed(): State {
  const org = (id: string) => ({
    id,
    name: id.toUpperCase(),
    slug: id.toLowerCase(),
    cpuLimitMilli: null,
    memoryLimitBytes: null,
    backupR2Endpoint: null,
    backupR2Bucket: null,
    backupR2AccessKey: null,
    backupR2SecretKey: null
  });
  const user = (id: string) => ({
    id,
    email: `${id}@example.com`,
    username: id,
    isSuperAdmin: false
  });
  return {
    orgs: { orgA: org('orgA'), orgB: org('orgB'), orgC: org('orgC') },
    users: Object.fromEntries(
      ['ada', 'bea', 'cal', 'dot', 'eve', 'fay', 'gus', 'max', 'oli'].map((id) => [id, user(id)])
    ),
    orgMembers: [
      { organizationId: 'orgA', userId: 'ada', role: 'admin', status: 'active' },
      { organizationId: 'orgB', userId: 'ada', role: 'member', status: 'active' },
      { organizationId: 'orgA', userId: 'bea', role: 'owner', status: 'active' },
      { organizationId: 'orgB', userId: 'bea', role: 'admin', status: 'active' },
      { organizationId: 'orgA', userId: 'cal', role: 'member', status: 'active' },
      { organizationId: 'orgA', userId: 'dot', role: 'member', status: 'active' },
      { organizationId: 'orgB', userId: 'dot', role: 'member', status: 'active' },
      { organizationId: 'orgA', userId: 'eve', role: 'admin', status: 'active' },
      { organizationId: 'orgA', userId: 'fay', role: 'admin', status: 'active' },
      { organizationId: 'orgB', userId: 'fay', role: 'guest', status: 'active' },
      { organizationId: 'orgA', userId: 'gus', role: 'admin', status: 'active' },
      { organizationId: 'orgB', userId: 'gus', role: 'admin', status: 'active' },
      { organizationId: 'orgB', userId: 'max', role: 'member', status: 'active' },
      { organizationId: 'orgA', userId: 'oli', role: 'member', status: 'active' }
    ],
    roles: [
      { id: ROLE.admin, name: 'admin' },
      { id: ROLE.member, name: 'member' },
      { id: ROLE.viewer, name: 'viewer' }
    ],
    projects: {
      p1: {
        id: 'p1',
        name: 'Shop',
        slug: 'shop',
        namespace: 'orga-shop',
        organizationId: 'orgA',
        ownerId: 'oli'
      },
      p2: {
        id: 'p2',
        name: 'Taken',
        slug: 'shop',
        namespace: 'orgb-shop',
        organizationId: 'orgB',
        ownerId: 'max'
      }
    },
    projectMembers: [
      { id: 'pm-cal', projectId: 'p1', userId: 'cal', roleId: ROLE.admin },
      { id: 'pm-dot', projectId: 'p1', userId: 'dot', roleId: ROLE.member },
      { id: 'pm-oli', projectId: 'p1', userId: 'oli', roleId: ROLE.admin },
      { id: 'pm-gus', projectId: 'p1', userId: 'gus', roleId: ROLE.viewer }
    ],
    invitations: [
      { id: 'inv-1', projectId: 'p1' },
      { id: 'inv-2', projectId: 'p2' }
    ],
    channels: [
      { id: 'ch-project', organizationId: 'orgA', scopeType: 'project', scopeId: 'p1' },
      { id: 'ch-org', organizationId: 'orgA', scopeType: 'organization', scopeId: null },
      { id: 'ch-other', organizationId: 'orgA', scopeType: 'project', scopeId: 'p9' }
    ],
    rules: [
      { id: 'ru-project', organizationId: 'orgA', scopeType: 'project', scopeId: 'p1' },
      { id: 'ru-org', organizationId: 'orgA', scopeType: 'organization', scopeId: null }
    ],
    environments: [
      { projectId: 'p1', namespace: 'orga-shop' },
      { projectId: 'p1', namespace: 'orga-shop-staging' }
    ],
    deployments: [{ projectId: 'p1', cpuRequestMilli: 500, memoryRequestBytes: 0n, replicas: 2 }],
    databases: [{ projectId: 'p1', cpuRequestMilli: 250, memoryRequestBytes: 0n, replicas: 1 }]
  };
}

function matches(row: Record<string, any>, where: Record<string, any> = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

function client(s: State, failOn?: string) {
  const trip = (op: string) => {
    if (failOn === op) throw new Error(`${op} failed`);
  };
  let seq = 0;
  const withMembers = (p: any) => ({
    ...p,
    organization: { ...s.orgs[p.organizationId] },
    members: s.projectMembers
      .filter((m) => m.projectId === p.id)
      .map((m) => ({ ...m, user: { id: m.userId, username: s.users[m.userId].username } }))
  });
  return {
    user: {
      findUnique: async ({ where }: any) => s.users[where.id] ?? null
    },
    organization: {
      findUnique: async ({ where }: any) => (s.orgs[where.id] ? { ...s.orgs[where.id] } : null)
    },
    organizationMember: {
      findUnique: async ({ where }: any) => {
        const { organizationId, userId } = where.organizationId_userId;
        return s.orgMembers.find((m) => matches(m, { organizationId, userId })) ?? null;
      },
      findFirst: async ({ where }: any) => s.orgMembers.find((m) => matches(m, where)) ?? null,
      findMany: async ({ where }: any) => s.orgMembers.filter((m) => matches(m, where))
    },
    orgSsoSettings: { findFirst: async () => null },
    role: {
      findFirst: async ({ where }: any) => s.roles.find((r) => r.name === where.name) ?? null
    },
    project: {
      findUnique: async ({ where, include }: any) => {
        const row = where.organizationId_slug
          ? Object.values(s.projects).find((p: any) => matches(p, where.organizationId_slug))
          : s.projects[where.id];
        if (!row) return null;
        return include ? withMembers(row) : { ...row };
      },
      update: async ({ where, data }: any) => {
        trip('project.update');
        return Object.assign(s.projects[where.id], data);
      }
    },
    projectMember: {
      findFirst: async ({ where }: any) => {
        const row = s.projectMembers.find((m) => matches(m, where));
        return row ? { ...row, role: s.roles.find((r) => r.id === row.roleId) } : null;
      },
      findUnique: async ({ where }: any) =>
        s.projectMembers.find((m) => matches(m, where.projectId_userId)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `pm-new-${++seq}`, ...data };
        s.projectMembers.push(row);
        return row;
      },
      update: async ({ where, data }: any) =>
        Object.assign(
          s.projectMembers.find((m) => m.id === where.id)!,
          data
        ),
      deleteMany: async ({ where }: any) => {
        trip('projectMember.deleteMany');
        const before = s.projectMembers.length;
        s.projectMembers = s.projectMembers.filter((m) => !matches(m, where));
        return { count: before - s.projectMembers.length };
      }
    },
    projectInvitation: {
      deleteMany: async ({ where }: any) => {
        trip('projectInvitation.deleteMany');
        s.invitations = s.invitations.filter((i) => !matches(i, where));
        return {};
      }
    },
    notificationChannel: {
      updateMany: async ({ where, data }: any) => {
        trip('notificationChannel.updateMany');
        for (const c of s.channels.filter((c) => matches(c, where))) Object.assign(c, data);
        return {};
      }
    },
    notificationRule: {
      updateMany: async ({ where, data }: any) => {
        trip('notificationRule.updateMany');
        for (const r of s.rules.filter((r) => matches(r, where))) Object.assign(r, data);
        return {};
      }
    },
    environment: {
      findMany: async ({ where }: any) => s.environments.filter((e) => matches(e, where))
    },
    deployment: {
      findMany: async ({ where }: any) => s.deployments.filter((d) => matches(d, where))
    },
    database: {
      findMany: async ({ where }: any) => s.databases.filter((d) => matches(d, where)),
      count: async ({ where }: any) => s.databases.filter((d) => matches(d, where)).length
    }
  };
}

function world(
  opts: {
    failOn?: string;
    tagFails?: boolean;
    syncFails?: boolean;
    usage?: { cpuMilli: number; memoryBytes: number };
  } = {}
) {
  const box = { state: seed() };
  const calls = {
    tagged: [] as { ns: string; meta: any }[],
    invalidatedOrgs: [] as string[],
    revoked: [] as [string, string][],
    synced: [] as string[],
    quotaApplied: [] as string[],
    repointed: [] as [string, string][],
    audits: [] as any[]
  };
  const prisma: any = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === '$transaction') {
          return async (fn: (tx: any) => Promise<unknown>) => {
            const draft: State = structuredClone(box.state);
            const result = await fn(client(draft, opts.failOn));
            box.state = draft;
            return result;
          };
        }
        return (client(box.state, opts.failOn) as any)[key];
      }
    }
  );
  const authz = new AuthorizationService(prisma, {} as any);
  const usersService = {
    findOrCreateByClerkId: async (sub: string) => box.state.users[sub] ?? null
  };
  const quotas = {
    getOrgUsageWithCaps: async (orgId: string) => ({
      org: {
        cpuLimitMilli: box.state.orgs[orgId].cpuLimitMilli,
        memoryLimitBytes: box.state.orgs[orgId].memoryLimitBytes
      },
      usage: opts.usage ?? { cpuMilli: 0, memoryBytes: 0 }
    }),
    applyProjectQuota: async (id: string) => {
      calls.quotaApplied.push(id);
    }
  };
  const k8sNamespace = {
    tagNamespaceMoved: async (ns: string, meta: any) => {
      calls.tagged.push({ ns, meta });
      if (opts.tagFails) throw new Error('apiserver down');
    }
  };
  const databases = {
    hasBackupStorage: (org: any) => Boolean(org.backupR2Bucket),
    repointProjectBackupsToOrg: async (projectId: string, orgId: string) => {
      calls.repointed.push([projectId, orgId]);
    }
  };
  const membershipCache = {
    invalidateOrg: (id: string) => calls.invalidatedOrgs.push(id),
    revoked: (orgId: string, userId: string) => calls.revoked.push([orgId, userId])
  };
  const audit = {
    log: async (entry: any) => {
      calls.audits.push(entry);
    }
  };
  const registryCredentials = {
    syncProject: async (id: string) => {
      calls.synced.push(id);
      if (opts.syncFails) throw new Error('registry down');
    }
  };
  const service = new ProjectOrgTransferService(
    prisma,
    authz,
    quotas as any,
    usersService as any,
    k8sNamespace as any,
    databases as any,
    membershipCache as any,
    audit as any,
    registryCredentials as any
  );
  return {
    service,
    authz,
    calls,
    get state() {
      return box.state;
    }
  };
}

function as<T>(ctx: RequestAuthContext, fn: () => Promise<T>): Promise<T> {
  return requestAuthStorage.run(ctx, fn);
}

test('a source org admin who is a member of the destination can move the project', async () => {
  const w = world();
  const result = await w.service.transfer('p1', 'orgB', 'shop-moved', 'ada');
  assert.deepEqual(result, {
    id: 'p1',
    slug: 'shop-moved',
    organizationId: 'orgB',
    destinationOrgSlug: 'orgb'
  });
  assert.equal(w.state.projects.p1.organizationId, 'orgB');
});

test('an admin of the source org who left the moved project behind gets not-found on it', async () => {
  const w = world();
  await w.authz.requireProjectView('p1', 'eve');
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  await assert.rejects(w.authz.requireProjectView('p1', 'eve'), NotFoundException);
  await assert.rejects(w.authz.requireProjectEdit('p1', 'eve'), NotFoundException);
});

test('a project member who is not in the destination org is evicted and gets not-found', async () => {
  const w = world();
  await w.authz.requireProjectEdit('p1', 'cal');
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(
    w.state.projectMembers.some((m) => m.userId === 'cal'),
    false
  );
  await assert.rejects(w.authz.requireProjectView('p1', 'cal'), NotFoundException);
  assert.deepEqual(
    w.calls.revoked.filter(([, u]) => u === 'cal'),
    [['orgA', 'cal']]
  );
});

test('a project member who is also in the destination org keeps the same project role', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  const access = await w.authz.requireProjectView('p1', 'dot');
  assert.equal(access.organizationId, 'orgB');
  assert.equal(access.projectRoleName, 'member');
  assert.equal(access.canManageMembers, false);
});

test('a token confined to the source org stops reaching the project once it moves', async () => {
  const w = world();
  const sourceToken: RequestAuthContext = {
    apiTokenId: 'tok-a',
    tokenScopes: ['read', 'deploy'],
    sessionOrgId: 'orgA'
  };
  await as(sourceToken, () => w.authz.requireProjectView('p1', 'bea'));
  await w.service.transfer('p1', 'orgB', 'moved', 'bea');
  await assert.rejects(
    as(sourceToken, () => w.authz.requireProjectView('p1', 'bea')),
    NotFoundException
  );
  const destToken: RequestAuthContext = {
    apiTokenId: 'tok-b',
    tokenScopes: ['read'],
    sessionOrgId: 'orgB'
  };
  const access = await as(destToken, () => w.authz.requireProjectView('p1', 'bea'));
  assert.equal(access.organizationId, 'orgB');
});

test('a token confined to the destination org cannot pull a project out of the source org', async () => {
  const w = world();
  await assert.rejects(
    as({ apiTokenId: 't', tokenScopes: ['deploy'], sessionOrgId: 'orgB' }, () =>
      w.service.transfer('p1', 'orgB', undefined, 'bea')
    ),
    NotFoundException
  );
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('a token confined to the source org cannot push the project into another org', async () => {
  const w = world();
  await assert.rejects(
    as({ apiTokenId: 't', tokenScopes: ['deploy'], sessionOrgId: 'orgA' }, () =>
      w.service.transfer('p1', 'orgB', 'moved', 'bea')
    ),
    NotFoundException
  );
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('a project-scoped token cannot move the project even when its owner is an admin of both orgs', async () => {
  const w = world();
  await assert.rejects(
    as({ apiTokenId: 't', tokenScopes: ['deploy'], tokenProjectIds: ['p1'] }, () =>
      w.service.transfer('p1', 'orgB', 'moved', 'bea')
    ),
    ForbiddenException
  );
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('a project admin who is only a plain member of the source org cannot move it', async () => {
  const w = world();
  await assert.rejects(w.service.transfer('p1', 'orgB', 'moved', 'cal'), ForbiddenException);
  await assert.rejects(w.service.preview('p1', 'orgB', 'moved', 'cal'), ForbiddenException);
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('someone outside the source org gets not-found, even with an invalid destination', async () => {
  const w = world();
  for (const dest of ['orgB', '', 'orgA', 'nope']) {
    await assert.rejects(w.service.transfer('p1', dest, undefined, 'max'), NotFoundException, dest);
    await assert.rejects(w.service.preview('p1', dest, undefined, 'max'), NotFoundException, dest);
  }
  await assert.rejects(w.service.transfer('ghost', 'orgB', undefined, 'bea'), NotFoundException);
});

test('a source admin cannot move a project into an org they do not belong to', async () => {
  const w = world();
  await assert.rejects(
    w.service.transfer('p1', 'orgC', 'moved', 'eve'),
    (err: unknown) => err instanceof NotFoundException && /Organization/.test(err.message)
  );
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('a guest of the destination org cannot move a project into it', async () => {
  const w = world();
  await assert.rejects(w.service.transfer('p1', 'orgB', 'moved', 'fay'), ForbiddenException);
  assert.equal(w.state.projects.p1.organizationId, 'orgA');
});

test('a destination member alone may move a project in, the same gate as creating one there', async () => {
  const w = world();
  const access = await w.authz.getOrgAccess('orgB', 'ada');
  assert.equal(access?.isAdmin, false);
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(w.state.projects.p1.organizationId, 'orgB');
});

test('moving into the org the project is already in is refused', async () => {
  const w = world();
  await assert.rejects(w.service.transfer('p1', 'orgA', undefined, 'bea'), BadRequestException);
  await assert.rejects(w.service.transfer('p1', '', undefined, 'bea'), BadRequestException);
});

test('a slug collision in the destination refuses the move before anything is written', async () => {
  const w = world();
  const before = structuredClone(w.state);
  await assert.rejects(w.service.transfer('p1', 'orgB', undefined, 'bea'), BadRequestException);
  assert.deepEqual(w.state, before);
  assert.deepEqual(w.calls.tagged, []);
  assert.deepEqual(w.calls.audits, []);
});

test('a move past the destination quota needs an admin of the destination', async () => {
  const w = world({ usage: { cpuMilli: 900, memoryBytes: 0 } });
  w.state.orgs.orgB.cpuLimitMilli = 1000;
  const before = structuredClone(w.state);
  await assert.rejects(
    w.service.transfer('p1', 'orgB', 'moved', 'ada'),
    (err: unknown) => err instanceof ForbiddenException && /limits/.test(err.message)
  );
  assert.deepEqual(w.state, before);
  const preview = await w.service.preview('p1', 'orgB', 'moved', 'ada');
  assert.equal(preview.quota?.willExceed, true);
  assert.equal(preview.quota?.requestedCpuMilli, 1250);
  await w.service.transfer('p1', 'orgB', 'moved', 'bea');
  assert.equal(w.state.projects.p1.organizationId, 'orgB');
});

test('a failure inside the move leaves the project, members, invitations and channels untouched', async () => {
  for (const failOn of [
    'project.update',
    'projectMember.deleteMany',
    'projectInvitation.deleteMany',
    'notificationChannel.updateMany',
    'notificationRule.updateMany'
  ]) {
    const w = world({ failOn });
    const before = structuredClone(w.state);
    await assert.rejects(w.service.transfer('p1', 'orgB', 'moved', 'ada'), /failed/, failOn);
    assert.deepEqual(w.state, before, failOn);
    await w.authz.requireProjectView('p1', 'cal');
    assert.deepEqual(w.calls.invalidatedOrgs, [], failOn);
    assert.deepEqual(w.calls.revoked, [], failOn);
    assert.deepEqual(w.calls.tagged, [], failOn);
    assert.deepEqual(w.calls.audits, [], failOn);
  }
});

test('pending invitations to the moved project are dropped, other projects keep theirs', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(
    w.state.invitations.map((i) => i.id),
    ['inv-2']
  );
});

test('only the moved project notification channels and rules follow it to the destination', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  const orgOf = (rows: { id: string; organizationId: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.id, r.organizationId]));
  assert.deepEqual(orgOf(w.state.channels), {
    'ch-project': 'orgB',
    'ch-org': 'orgA',
    'ch-other': 'orgA'
  });
  assert.deepEqual(orgOf(w.state.rules), { 'ru-project': 'orgB', 'ru-org': 'orgA' });
});

test('an owner who is not in the destination is replaced by the mover, who becomes project admin', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(w.state.projects.p1.ownerId, 'ada');
  const mover = w.state.projectMembers.find((m) => m.userId === 'ada');
  assert.equal(mover?.roleId, ROLE.admin);
  assert.equal(
    w.state.projectMembers.some((m) => m.userId === 'oli'),
    false
  );
  await assert.rejects(w.authz.requireProjectView('p1', 'oli'), NotFoundException);
  const access = await w.authz.requireProjectView('p1', 'ada');
  assert.equal(access.canManageMembers, true);
});

test('a mover who held a lesser project role is promoted when they take ownership', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'gus');
  assert.equal(w.state.projects.p1.ownerId, 'gus');
  assert.equal(w.state.projectMembers.find((m) => m.userId === 'gus')?.roleId, ROLE.admin);
});

test('an owner who is already in the destination keeps ownership', async () => {
  const w = world();
  w.state.projects.p1.ownerId = 'dot';
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(w.state.projects.p1.ownerId, 'dot');
  assert.equal(w.state.projectMembers.find((m) => m.userId === 'dot')?.roleId, ROLE.member);
});

test('membership caches for both orgs are dropped after the move', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(w.calls.invalidatedOrgs, ['orgA', 'orgB']);
  assert.deepEqual(w.calls.revoked.sort(), [
    ['orgA', 'cal'],
    ['orgA', 'oli']
  ]);
});

test('every namespace of the project is tagged with the move, and a tag failure does not undo it', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(
    w.calls.tagged.map((t) => t.ns),
    ['orga-shop', 'orga-shop-staging']
  );
  assert.deepEqual(w.calls.tagged[0].meta, {
    fromOrgSlug: 'orga',
    toOrgSlug: 'orgb',
    movedBy: 'ada@example.com'
  });
  assert.deepEqual(w.calls.synced, ['p1']);
  assert.deepEqual(w.calls.quotaApplied, ['p1']);

  const failing = world({ tagFails: true });
  await failing.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(failing.state.projects.p1.organizationId, 'orgB');
  assert.equal(failing.calls.tagged.length, 2);
  assert.deepEqual(failing.calls.invalidatedOrgs, ['orgA', 'orgB']);
});

test('the move is audited in both orgs', async () => {
  const w = world();
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(
    w.calls.audits.map((a) => [a.organizationId, a.action, a.actorUserId]),
    [
      ['orgB', 'project.organization.transferred', 'ada'],
      ['orgA', 'project.organization.transferred', 'ada']
    ]
  );
  assert.equal(w.calls.audits[0].metadata.membersEvicted, 2);
});

test('the preview changes nothing and names who would lose access', async () => {
  const w = world();
  const before = structuredClone(w.state);
  const preview = await w.service.preview('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(w.state, before);
  assert.deepEqual(preview.membersLosingAccess.map((m) => m.id).sort(), ['cal', 'oli']);
  assert.equal(preview.membersKept, 2);
  assert.equal(preview.ownerReassignedToMover, true);
  assert.deepEqual(w.calls.audits, []);
});

test('backups follow only when the destination has storage, and pause when it has none', async () => {
  const toEmpty = world();
  toEmpty.state.orgs.orgA.backupR2Bucket = 'a-bucket';
  const paused = await toEmpty.service.preview('p1', 'orgB', 'moved', 'ada');
  assert.deepEqual(paused.backups, { databaseCount: 1, willContinue: false, willPause: true });

  const toStored = world();
  toStored.state.orgs.orgB.backupR2Bucket = 'b-bucket';
  await toStored.service.transfer('p1', 'orgB', 'moved', 'ada');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(toStored.calls.repointed, [['p1', 'orgB']]);
});

test('a registry credential sync failure after the commit still drops caches, re-applies quota, re-points backups and audits the move', async () => {
  const w = world({ syncFails: true });
  await w.service.transfer('p1', 'orgB', 'moved', 'ada');
  assert.equal(w.state.projects.p1.organizationId, 'orgB');
  assert.deepEqual(w.calls.synced, ['p1']);
  assert.deepEqual(w.calls.invalidatedOrgs, ['orgA', 'orgB']);
  assert.deepEqual(w.calls.revoked.map(([, u]) => u).sort(), ['cal', 'oli']);
  assert.deepEqual(w.calls.quotaApplied, ['p1']);
  assert.equal(w.calls.audits.length, 2);
});

test.todo(
  'a failed backup re-point or pull secret rewrite is retried, so source org credentials do not stay in a namespace the destination now owns'
);
