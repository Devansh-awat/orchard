import { Controller, Get, Post, Patch, Delete, Put, Param, Body, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { EnvironmentSharedVarsService, SharedVarInput } from './environment-shared-vars.service';

function userData(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl
  };
}

@Auth()
@Controller()
export class EnvironmentsController {
  constructor(
    private readonly environments: EnvironmentsService,
    private readonly sharedVars: EnvironmentSharedVarsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly authz: AuthorizationService
  ) {}

  @Get('projects/:projectId/environments')
  async list(@Param('projectId') projectId: string, @Request() req) {
    await this.projectAccess.assertProjectView(projectId, req.user.sub, userData(req));
    return this.environments.listEnvironments(projectId);
  }

  @Post('projects/:projectId/environments')
  async create(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; slug?: string },
    @Request() req
  ) {
    const { user } = await this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      'create environments'
    );
    return this.environments.createEnvironment(projectId, body ?? ({} as any), user.id);
  }

  @Patch('environments/:id')
  async rename(@Param('id') id: string, @Body() body: { name: string }, @Request() req) {
    const { user } = await this.resolveEnvEdit(id, req, 'rename environments');
    return this.environments.renameEnvironment(id, body?.name ?? '', user.id);
  }

  @Post('environments/:id/set-default')
  async setDefault(@Param('id') id: string, @Request() req) {
    const { user } = await this.resolveEnvEdit(id, req, 'change the default environment');
    return this.environments.setDefaultEnvironment(id, user.id);
  }

  @Delete('environments/:id')
  async remove(
    @Param('id') id: string,
    @Body() body: { confirmName?: string } | undefined,
    @Request() req
  ) {
    const { user } = await this.resolveEnvView(id, req);
    const projectId = await this.environments.projectIdForEnv(id);
    await this.authz.requireProjectDelete(projectId, user.id);
    return this.environments.deleteEnvironment(
      id,
      { userId: user.id, email: user.email ?? undefined },
      body?.confirmName
    );
  }

  @Get('environments/:id/shared-vars')
  async getShared(@Param('id') id: string, @Request() req) {
    const { access } = await this.resolveEnvView(id, req);
    return this.sharedVars.getSharedVars(id, access.canEdit);
  }

  @Put('environments/:id/shared-vars')
  async putShared(
    @Param('id') id: string,
    @Body() body: { vars: SharedVarInput[] },
    @Request() req
  ) {
    const { user } = await this.resolveEnvEdit(id, req, 'manage shared variables');
    return this.sharedVars.updateSharedVars(id, body?.vars ?? [], user.id);
  }

  private async resolveEnvEdit(environmentId: string, req: any, action: string) {
    const projectId = await this.environments.projectIdForEnv(environmentId);
    return this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      action
    );
  }

  private async resolveEnvView(environmentId: string, req: any) {
    const projectId = await this.environments.projectIdForEnv(environmentId);
    return this.projectAccess.assertProjectView(projectId, req.user.sub, userData(req));
  }
}
