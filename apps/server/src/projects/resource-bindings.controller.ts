import { Body, Controller, Delete, Get, Param, Post, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from './project-access.service';
import { AuthorizationService } from '../auth/authorization.service';
import { DeploymentsService } from './deployments.service';
import {
  PRIMARY_FIELD,
  ResourceBindingsService,
  resourceRef,
  type BindInput
} from './resource-bindings.service';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

@Auth()
@Controller('deployments')
export class ResourceBindingsController {
  constructor(
    private readonly bindings: ResourceBindingsService,
    private readonly deployments: DeploymentsService,
    private readonly access: ProjectAccessService,
    private readonly authz: AuthorizationService
  ) {}

  private userData(req: any) {
    return {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    };
  }

  private async requireEdit(deploymentId: string, req: any) {
    const { user, deployment } = await this.access.assertDeploymentView(
      deploymentId,
      req.user.sub,
      this.userData(req)
    );
    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'update deployments');
    return user;
  }

  @Get(':id/bindings')
  async list(@Param('id') id: string, @Request() req) {
    await this.access.assertDeploymentView(id, req.user.sub, this.userData(req));
    return this.bindings.list(id);
  }

  @Get(':id/bindings/options')
  async options(@Param('id') id: string, @Request() req) {
    await this.access.assertDeploymentView(id, req.user.sub, this.userData(req));
    return this.bindings.options(id);
  }

  @Post(':id/bindings')
  async bind(
    @Param('id') id: string,
    @Body() body: BindInput & { envKey?: string | null },
    @Request() req
  ) {
    const user = await this.requireEdit(id, req);
    const binding = await this.bindings.bind(id, body ?? {}, user.id);
    const envKey = typeof body?.envKey === 'string' ? body.envKey.trim() : '';
    let addedEnvKey: string | null = null;
    if (envKey) {
      if (!ENV_KEY_RE.test(envKey)) {
        return { ...binding, addedEnvKey: null };
      }
      const current = await this.deployments.getDeploymentEnvKeys(id);
      if (!current.some((v) => v.key === envKey)) {
        await this.deployments.updateDeploymentEnvVars(
          id,
          [
            ...current.map((v) => ({ key: v.key, value: null, secret: v.secret })),
            {
              key: envKey,
              value: resourceRef(binding.name, PRIMARY_FIELD[binding.resourceType]),
              secret: false
            }
          ],
          req.user.sub,
          this.userData(req)
        );
        addedEnvKey = envKey;
      }
    }
    return { ...binding, addedEnvKey };
  }

  @Delete(':id/bindings/:bindingId')
  async unbind(@Param('id') id: string, @Param('bindingId') bindingId: string, @Request() req) {
    const user = await this.requireEdit(id, req);
    await this.bindings.unbind(id, bindingId, user.id);
    return { success: true };
  }
}
