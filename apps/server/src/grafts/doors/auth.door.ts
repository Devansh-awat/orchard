import { ForbiddenException, Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { SignJWT } from 'jose';
import { AuthorizationService } from '../../auth/authorization.service';
import {
  denyToOrgScopedSessions,
  orgScopedDevice,
  registerOrgScopedDevice
} from '../../auth/org-scoped-devices';
import { requestAuthStorage, type RequestAuthContext } from '../../auth/request-context';
import { SessionsService } from '../../auth/sessions.service';
import {
  authenticateUpgrade,
  originAllowed,
  platformOrigins,
  rejectUpgrade,
  type UpgradeIdentity
} from '../../auth/upgrade-auth';
import {
  authenticateUpgrade as authenticateExecUpgrade,
  type EngineAuth,
  type Rejection
} from '../../kubernetes/exec-session-engine';
import { PrismaService } from '../../prisma/prisma.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

const DAY_MS = 86_400_000;

function jwtSecret(): string {
  return process.env.JWT_SECRET || '';
}

type PermissionScope = { organizationId?: string; projectId?: string };

@Injectable({ scope: Scope.TRANSIENT })
export class AuthDoorV1 {
  static readonly meta: DoorMeta = { name: 'auth', version: 1, status: 'stable' };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {
    this.graft = bindGraft(parent, AuthDoorV1.meta);
  }

  isSuperAdmin(userId: string) {
    return this.authz.isSuperAdmin(userId);
  }

  getOrgAccess(organizationId: string, userId: string) {
    return this.authz.getOrgAccess(organizationId, userId);
  }

  getProjectAccess(projectId: string, userId: string) {
    return this.authz.getProjectAccess(projectId, userId);
  }

  requireOrgMember(organizationId: string, userId: string) {
    return this.authz.requireOrgMember(organizationId, userId);
  }

  requireOrgAdmin(organizationId: string, userId: string) {
    return this.authz.requireOrgAdmin(organizationId, userId);
  }

  requireOrgOwner(organizationId: string, userId: string) {
    return this.authz.requireOrgOwner(organizationId, userId);
  }

  requireProjectView(projectId: string, userId: string) {
    return this.authz.requireProjectView(projectId, userId);
  }

  requireProjectEdit(projectId: string, userId: string) {
    return this.authz.requireProjectEdit(projectId, userId);
  }

  requireOrgCanCreateProjects(organizationId: string, userId: string) {
    return this.authz.requireOrgCanCreateProjects(organizationId, userId);
  }

  validateSession(sessionId: string): Promise<boolean> {
    return this.sessions.validateSession(sessionId);
  }

  requestContext(): RequestAuthContext | undefined {
    return requestAuthStorage.getStore();
  }

  runWithContext<T>(ctx: RequestAuthContext, fn: () => T): T {
    return requestAuthStorage.run(ctx, fn);
  }

  authenticateUpgrade(
    req: IncomingMessage,
    requiredScope: string
  ): Promise<UpgradeIdentity | null> {
    return authenticateUpgrade(req, {
      prisma: this.prisma,
      sessions: this.sessions,
      jwtSecret: jwtSecret(),
      requiredScope
    });
  }

  authenticateTerminalUpgrade(req: IncomingMessage): Promise<EngineAuth | Rejection> {
    return authenticateExecUpgrade(req, {
      prisma: this.prisma,
      sessions: this.sessions,
      jwtSecret: new TextEncoder().encode(jwtSecret())
    });
  }

  originAllowed(origin: string | undefined, via: 'cookie' | 'bearer'): boolean {
    return originAllowed(origin, platformOrigins(), via);
  }

  rejectUpgrade(socket: Duplex, status: number, message: string): void {
    rejectUpgrade(socket, status, message);
  }

  registerOrgScopedDevice(prefix: string, denyPaths: string[] = []): void {
    assertClaimed(this.graft, 'deviceNames', prefix, 'device name');
    registerOrgScopedDevice(prefix);
    for (const path of denyPaths) {
      denyToOrgScopedSessions(path);
      denyToOrgScopedSessions(`${this.graft.id}/${path}`);
    }
  }

  deviceName(prefix: string, organizationId: string | null | undefined, subject: string): string {
    assertClaimed(this.graft, 'deviceNames', prefix, 'device name');
    return orgScopedDevice(prefix, organizationId, subject);
  }

  async revokeDeviceSessions(userId: string, deviceNames: string[]): Promise<number> {
    for (const name of deviceNames) {
      assertClaimed(this.graft, 'deviceNames', name.split(':')[0], 'device name');
    }
    const result = await this.prisma.session.updateMany({
      where: { userId, deviceName: { in: deviceNames }, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return result.count;
  }

  async mintDeviceToken(input: {
    userId: string;
    deviceName: string;
    ttlDays: number;
    reuseIfValidForDays?: number;
  }): Promise<string | null> {
    assertClaimed(this.graft, 'deviceNames', input.deviceName.split(':')[0], 'device name');
    if (!jwtSecret()) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, username: true, externalAuthId: true }
    });
    if (!user) return null;
    const reuseUntil = new Date(Date.now() + (input.reuseIfValidForDays ?? 0) * DAY_MS);
    const session =
      (input.reuseIfValidForDays !== undefined
        ? await this.prisma.session.findFirst({
            where: {
              userId: input.userId,
              deviceName: input.deviceName,
              revokedAt: null,
              expiresAt: { gt: reuseUntil }
            }
          })
        : null) ??
      (await this.prisma.session.create({
        data: {
          userId: input.userId,
          authMethod: 'otp',
          deviceName: input.deviceName,
          expiresAt: new Date(Date.now() + input.ttlDays * DAY_MS)
        }
      }));
    return new SignJWT({
      type: 'mcp',
      email: user.email,
      name: user.username,
      externalAuthId: user.externalAuthId,
      authMethod: 'otp',
      sessionId: session.id
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userId)
      .setIssuedAt()
      .setExpirationTime(`${input.ttlDays}d`)
      .sign(new TextEncoder().encode(jwtSecret()));
  }

  listVisibleProjectIds(organizationId: string, userId: string) {
    return this.authz.listVisibleProjectIds(organizationId, userId);
  }

  async can(userId: string, permission: string, scope: PermissionScope = {}): Promise<boolean> {
    const key = permission.startsWith(`${this.graft.id}.`)
      ? permission.slice(this.graft.id.length + 1)
      : permission;
    const declared = this.graft.manifest!.permissions[key];
    if (!declared)
      throw new Error(`graft ${this.graft.id} checks undeclared permission "${permission}"`);
    if (await this.authz.isSuperAdmin(userId)) return true;
    const grants = new Set<string>(declared.defaultGrants);
    if (scope.projectId) {
      const access = await this.authz.getProjectAccess(scope.projectId, userId);
      if (!access) return false;
      if (access.projectRoleName && grants.has(`project:${access.projectRoleName}`)) return true;
      if (access.orgRole && grants.has(`org:${access.orgRole}`)) return true;
      return false;
    }
    if (scope.organizationId) {
      const access = await this.authz.getOrgAccess(scope.organizationId, userId);
      return !!access && grants.has(`org:${access.role}`);
    }
    return false;
  }

  async require(userId: string, permission: string, scope: PermissionScope = {}): Promise<void> {
    if (!(await this.can(userId, permission, scope))) throw new ForbiddenException();
  }
}
