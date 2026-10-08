import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Sandbox } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { requestAuthStorage } from '../auth/request-context';

export type SandboxRole = 'owner' | 'collaborator' | 'viewer' | 'admin';

export type SandboxMinRole = 'viewer' | 'collaborator' | 'owner';

export interface SandboxRoleOptions {
  orgAdmin?: boolean;
}

export interface SandboxRoleResolution {
  role: SandboxRole | null;
  orgAdmin: boolean;
  superadmin: boolean;
}

export const SANDBOX_ACCESS_INCLUDE = {
  sshIdentity: { select: { id: true, name: true } },
  user: { select: { id: true, username: true, email: true } }
} as const;

export type SandboxAccessRow = Sandbox & {
  sshIdentity: { id: string; name: string } | null;
  user: { id: string; username: string | null; email: string | null } | null;
};

export interface SandboxAccess<T = SandboxAccessRow> {
  sandbox: T;
  userId: string;
  role: SandboxRole;
  orgAdmin: boolean;
  superadmin: boolean;
}

const MIN_LABEL: Record<SandboxMinRole, string> = {
  viewer: 'view this sandbox',
  collaborator: 'collaborate in this sandbox',
  owner: 'manage this sandbox'
};

export function sandboxRoleAllows(
  resolution: { role: SandboxRole | null; orgAdmin: boolean },
  min: SandboxMinRole,
  opts: SandboxRoleOptions = {}
): boolean {
  const { role, orgAdmin } = resolution;
  if (!role) return false;
  if (opts.orgAdmin && orgAdmin) return true;
  if (min === 'viewer') return true;
  if (min === 'collaborator') return role === 'owner' || role === 'collaborator';
  return role === 'owner';
}

export function rankSandboxRole(role: SandboxRole | null): number {
  if (role === 'owner') return 3;
  if (role === 'collaborator') return 2;
  if (role === 'admin') return 1;
  if (role === 'viewer') return 1;
  return 0;
}

@Injectable()
export class SandboxAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService
  ) {}

  async sandboxRoleOf(
    sandbox: { id: string; userId: string; organizationId: string | null },
    userId: string
  ): Promise<SandboxRoleResolution> {
    if (!userId) return { role: null, orgAdmin: false, superadmin: false };
    const ctx = requestAuthStorage.getStore();
    if (ctx?.sessionOrgId && ctx.sessionOrgId !== sandbox.organizationId) {
      return { role: null, orgAdmin: false, superadmin: false };
    }
    if (ctx?.tokenProjectIds && ctx.tokenProjectIds.length > 0) {
      return { role: null, orgAdmin: false, superadmin: false };
    }
    if (await this.authz.isSuperAdmin(userId)) {
      return { role: 'owner', orgAdmin: true, superadmin: true };
    }
    if (!sandbox.organizationId) {
      if (sandbox.userId === userId) return { role: 'owner', orgAdmin: false, superadmin: false };
      return { role: null, orgAdmin: false, superadmin: false };
    }
    const owner = sandbox.userId === userId;
    const [org, member] = await Promise.all([
      this.authz.getOrgAccess(sandbox.organizationId, userId).catch(() => null),
      owner
        ? Promise.resolve(null)
        : this.prisma.sandboxMember.findUnique({
            where: { sandboxId_userId: { sandboxId: sandbox.id, userId } },
            select: { role: true }
          })
    ]);
    if (!org) return { role: null, orgAdmin: false, superadmin: false };
    if (owner) return { role: 'owner', orgAdmin: false, superadmin: false };
    const orgAdmin = org.isAdmin;
    if (member?.role === 'collaborator')
      return { role: 'collaborator', orgAdmin, superadmin: false };
    if (orgAdmin) return { role: 'admin', orgAdmin, superadmin: false };
    if (member?.role === 'viewer') return { role: 'viewer', orgAdmin, superadmin: false };
    return { role: null, orgAdmin: false, superadmin: false };
  }

  async resolve(sandboxId: string, userId: string): Promise<SandboxAccess | null> {
    const sandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      include: SANDBOX_ACCESS_INCLUDE
    });
    if (!sandbox) return null;
    const resolution = await this.sandboxRoleOf(sandbox, userId);
    if (!resolution.role) return null;
    return {
      sandbox,
      userId,
      role: resolution.role,
      orgAdmin: resolution.orgAdmin,
      superadmin: resolution.superadmin
    };
  }

  async requireSandboxRole(
    sandboxId: string,
    userId: string,
    min: SandboxMinRole,
    opts: SandboxRoleOptions = {}
  ): Promise<SandboxAccess> {
    const access = await this.resolve(sandboxId, userId);
    if (!access) throw new NotFoundException('Sandbox not found');
    if (!sandboxRoleAllows(access, min, opts)) {
      throw new ForbiddenException(`Your role does not allow you to ${MIN_LABEL[min]}`);
    }
    return access;
  }

  async sharedSandboxIds(userId: string): Promise<Map<string, 'viewer' | 'collaborator'>> {
    const rows = await this.prisma.sandboxMember.findMany({
      where: { userId, sandbox: { desiredState: { not: 'deleted' } } },
      select: {
        role: true,
        sandboxId: true,
        sandbox: { select: { organizationId: true } }
      }
    });
    const out = new Map<string, 'viewer' | 'collaborator'>();
    const orgOk = new Map<string, boolean>();
    for (const row of rows) {
      const orgId = row.sandbox.organizationId;
      if (!orgId) continue;
      if (!orgOk.has(orgId)) {
        const access = await this.authz.getOrgAccess(orgId, userId).catch(() => null);
        orgOk.set(orgId, !!access);
      }
      if (orgOk.get(orgId)) out.set(row.sandboxId, row.role);
    }
    return out;
  }
}
