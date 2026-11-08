import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { MCP_SERVICE_TOKEN } from './harness';
import {
  mintJwt,
  newApiToken,
  type OrgKey,
  type ProjectKey,
  type UserKey,
  type World
} from './world';

export type Relation = 'anon' | 'cross-org' | 'cross-project' | 'lower-role' | 'owner';

export interface Principal {
  key: string;
  label: string;
  relation: Relation;
  headers: Record<string, string>;
  userKey: UserKey | null;
  home: { orgKey: OrgKey | null; projectKey: ProjectKey | null };
  victim: { orgKey: OrgKey; projectKey: ProjectKey };
  orgs: Set<string>;
  projects: Set<string>;
  writesOnly: boolean;
  sameOrg: boolean;
}

interface Spec {
  key: string;
  label: string;
  relation: Relation;
  user: UserKey | null;
  auth: 'none' | 'session' | 'orgSession' | 'token' | 'gateway';
  scopes?: string[];
  restrictTo?: ProjectKey[];
  scopeOrg?: OrgKey;
  orgDevice?: OrgKey;
  gatewayScope?: 'read' | 'deploy' | 'exec';
  home: { orgKey: OrgKey | null; projectKey: ProjectKey | null };
  victim: { orgKey: OrgKey; projectKey: ProjectKey };
  orgs: OrgKey[];
  projects: ProjectKey[];
  writesOnly?: boolean;
}

const V1 = { orgKey: 'o1' as OrgKey, projectKey: 'p1' as ProjectKey };
const V3 = { orgKey: 'o2' as OrgKey, projectKey: 'p3' as ProjectKey };

export const SPECS: Spec[] = [
  {
    key: 'anon',
    label: 'no credentials',
    relation: 'anon',
    user: null,
    auth: 'none',
    home: { orgKey: null, projectKey: null },
    victim: V1,
    orgs: [],
    projects: []
  },
  {
    key: 'o2Session',
    label: 'owner of the other org (session)',
    relation: 'cross-org',
    user: 'o2Owner',
    auth: 'session',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'o2Token',
    label: 'owner of the other org (API token, exec)',
    relation: 'cross-org',
    user: 'o2Owner',
    auth: 'token',
    scopes: ['read', 'deploy', 'exec'],
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'o2Mcp',
    label: 'owner of the other org (MCP gateway, exec)',
    relation: 'cross-org',
    user: 'o2Owner',
    auth: 'gateway',
    gatewayScope: 'exec',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'dualScopedSession',
    label: 'member of both orgs, session scoped to the other org',
    relation: 'cross-org',
    user: 'dual',
    auth: 'orgSession',
    scopeOrg: 'o2',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'dualScopedToken',
    label: 'member of both orgs, API token scoped to the other org',
    relation: 'cross-org',
    user: 'dual',
    auth: 'token',
    scopes: ['read', 'deploy', 'exec'],
    scopeOrg: 'o2',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'dualScopedMcp',
    label: 'member of both orgs, MCP grant scoped to the other org',
    relation: 'cross-org',
    user: 'dual',
    auth: 'gateway',
    gatewayScope: 'exec',
    orgDevice: 'o2',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V1,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  },
  {
    key: 'o1OwnerVsO2',
    label: 'owner of org 1 reaching into org 2',
    relation: 'cross-org',
    user: 'o1Owner',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: 'p1' },
    victim: V3,
    orgs: ['o1'],
    projects: ['p1', 'p2']
  },
  {
    key: 'p2Member',
    label: 'member of the other project, same org',
    relation: 'cross-project',
    user: 'o1P2Member',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: 'p2' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p2']
  },
  {
    key: 'p2Token',
    label: 'owner token restricted to the other project, same org',
    relation: 'cross-project',
    user: 'o1Owner',
    auth: 'token',
    scopes: ['read', 'deploy', 'exec'],
    restrictTo: ['p2'],
    home: { orgKey: 'o1', projectKey: 'p2' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p2']
  },
  {
    key: 'orgPlain',
    label: 'plain org member with no project membership',
    relation: 'cross-project',
    user: 'o1Plain',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: null },
    victim: V1,
    orgs: ['o1'],
    projects: []
  },
  {
    key: 'orgGuest',
    label: 'org guest with no project membership',
    relation: 'cross-project',
    user: 'o1Guest',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: null },
    victim: V1,
    orgs: ['o1'],
    projects: []
  },
  {
    key: 'viewer',
    label: 'project viewer (lower role, same project)',
    relation: 'lower-role',
    user: 'o1Viewer',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: 'p1' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p1'],
    writesOnly: true
  },
  {
    key: 'readToken',
    label: 'read-only API token of a project admin (same project)',
    relation: 'lower-role',
    user: 'o1Admin',
    auth: 'token',
    scopes: ['read'],
    restrictTo: ['p1'],
    home: { orgKey: 'o1', projectKey: 'p1' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p1'],
    writesOnly: true
  },
  {
    key: 'readMcp',
    label: 'read-scoped MCP grant of a project admin (same project)',
    relation: 'lower-role',
    user: 'o1Admin',
    auth: 'gateway',
    gatewayScope: 'read',
    home: { orgKey: 'o1', projectKey: 'p1' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p1'],
    writesOnly: true
  },
  {
    key: 'owner1',
    label: 'owner of org 1 (positive and list control)',
    relation: 'owner',
    user: 'o1Owner',
    auth: 'session',
    home: { orgKey: 'o1', projectKey: 'p1' },
    victim: V1,
    orgs: ['o1'],
    projects: ['p1', 'p2']
  },
  {
    key: 'owner2',
    label: 'owner of org 2 (list control)',
    relation: 'owner',
    user: 'o2Owner',
    auth: 'session',
    home: { orgKey: 'o2', projectKey: 'p3' },
    victim: V3,
    orgs: ['o2'],
    projects: ['p3', 'p4']
  }
];

export async function buildPrincipals(prisma: PrismaClient, world: World): Promise<Principal[]> {
  const principals: Principal[] = [];
  for (const spec of SPECS) {
    const user = spec.user ? world.users[spec.user] : null;
    let headers: Record<string, string> = {};
    if (spec.auth === 'session' && user) {
      headers = { authorization: `Bearer ${user.jwt}` };
    } else if (spec.auth === 'orgSession' && user && spec.scopeOrg) {
      const sessionId = randomUUID();
      await prisma.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          expiresAt: new Date(Date.now() + 2 * 3600_000),
          userAgent: world.tag
        }
      });
      const jwt = await mintJwt(world.secret, user.id, sessionId, world.orgs[spec.scopeOrg].id);
      headers = { authorization: `Bearer ${jwt}` };
    } else if (spec.auth === 'token' && user) {
      const token = newApiToken();
      await prisma.apiToken.create({
        data: {
          name: `${world.tag}-principal-${spec.key}`,
          tokenHash: token.hash,
          scopes: spec.scopes ?? ['read'],
          restrictedProjectIds: (spec.restrictTo ?? []).map((key) => world.projects[key].id),
          scopeOrganizationId: spec.scopeOrg ? world.orgs[spec.scopeOrg].id : null,
          userId: user.id
        }
      });
      headers = { authorization: `Bearer ${token.plaintext}` };
    } else if (spec.auth === 'gateway' && user) {
      const sessionId = randomUUID();
      await prisma.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          expiresAt: new Date(Date.now() + 2 * 3600_000),
          userAgent: world.tag,
          deviceName: spec.orgDevice
            ? `mcp-org:${world.orgs[spec.orgDevice].id}:${world.tag}`
            : `mcp:${world.tag}`
        }
      });
      headers = {
        authorization: `Bearer ${MCP_SERVICE_TOKEN}`,
        'x-acting-user-sub': user.id,
        'x-acting-user-session-id': sessionId,
        'x-acting-user-email': user.email,
        'x-acting-user-scope': spec.gatewayScope ?? 'exec'
      };
    }
    principals.push({
      key: spec.key,
      label: spec.label,
      relation: spec.relation,
      headers,
      userKey: spec.user,
      home: spec.home,
      victim: spec.victim,
      orgs: new Set(spec.orgs.map((key) => world.orgs[key].id)),
      projects: new Set(spec.projects.map((key) => world.projects[key].id)),
      writesOnly: spec.writesOnly ?? false,
      sameOrg: spec.relation === 'cross-project' || spec.relation === 'lower-role'
    });
  }
  return principals;
}

export function forbiddenMarkers(world: World, principal: Principal): string[] {
  const out: string[] = [];
  for (const org of Object.values(world.orgs)) {
    if (!principal.orgs.has(org.id)) out.push(...org.markers);
  }
  for (const project of Object.values(world.projects)) {
    if (!principal.projects.has(project.id)) out.push(...project.markers);
  }
  for (const user of Object.values(world.users)) {
    if (user.key !== principal.userKey) out.push(...user.markers);
  }
  return out.filter((marker) => marker.length >= 8);
}
