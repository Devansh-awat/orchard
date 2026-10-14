import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  Doors,
  type AuthDoor,
  type OrgAccess,
  type ProjectAccess
} from '@orchardlabs/graft-sdk/server';

@Injectable()
export class AuthorizationService {
  constructor(@Inject(Doors.auth) private readonly auth: AuthDoor) {}

  isSuperAdmin(userId: string): Promise<boolean> {
    return this.auth.isSuperAdmin(userId);
  }

  getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null> {
    return this.auth.getOrgAccess(organizationId, userId);
  }

  requireOrgMember(organizationId: string, userId: string): Promise<OrgAccess> {
    return this.auth.requireOrgMember(organizationId, userId);
  }

  requireOrgCanCreateProjects(organizationId: string, userId: string): Promise<OrgAccess> {
    return this.auth.requireOrgCanCreateProjects(organizationId, userId);
  }

  getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
    return this.auth.getProjectAccess(projectId, userId);
  }

  resolveProjectAccess(
    projectId: string,
    _organizationId: string,
    userId: string
  ): Promise<ProjectAccess | null> {
    return this.auth.getProjectAccess(projectId, userId);
  }

  async requireProjectEdit(
    projectId: string,
    userId: string,
    action = 'modify this project'
  ): Promise<ProjectAccess> {
    const access = await this.auth.requireProjectView(projectId, userId);
    if (!access.canEdit) {
      throw new ForbiddenException(`Your role does not allow you to ${action}`);
    }
    return access;
  }
}
