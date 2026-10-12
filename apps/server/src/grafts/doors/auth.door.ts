import { ForbiddenException, Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { AuthorizationService } from '../../auth/authorization.service';
import type { GraftRecord } from '../graft-registry';
import { bindGraft, type DoorMeta } from './door';

type PermissionScope = { organizationId?: string; projectId?: string };

@Injectable({ scope: Scope.TRANSIENT })
export class AuthDoorV1 {
  static readonly meta: DoorMeta = { name: 'auth', version: 1, status: 'stable' };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService
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
