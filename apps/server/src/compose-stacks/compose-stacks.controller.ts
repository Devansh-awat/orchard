import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Request } from '@nestjs/common';
import { ComposeStacksService } from './compose-stacks.service';
import { Auth } from '../auth/decorators';

function userBag(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl,
  };
}

function clerkId(req: any) {
  return req.user.externalAuthId || req.user.sub;
}

@Auth()
@Controller()
export class ComposeStacksController {
  constructor(private readonly composeStacks: ComposeStacksService) {}

  @Post('projects/:projectId/compose-stacks/from-github')
  async createFromGithub(
    @Param('projectId') projectId: string,
    @Body() body: {
      name: string;
      repoUrl: string;
      branch: string;
      composePath?: string;
      autoDeployEnabled?: boolean;
    },
    @Request() req: any,
  ) {
    return this.composeStacks.createFromGithub(projectId, body, clerkId(req), userBag(req));
  }

  @Get('projects/:projectId/compose-stacks')
  async list(@Param('projectId') projectId: string, @Request() req: any) {
    return this.composeStacks.listForProject(projectId, clerkId(req), userBag(req));
  }

  @Get('compose-stacks/:id')
  async get(@Param('id') id: string, @Request() req: any) {
    return this.composeStacks.getComposeStack(id, clerkId(req), userBag(req));
  }

  @Post('compose-stacks/:id/redeploy')
  async redeploy(@Param('id') id: string, @Request() req: any) {
    return this.composeStacks.redeployFromGithub(id, clerkId(req), userBag(req));
  }

  @Put('compose-stacks/:id/auto-deploy')
  async setAutoDeploy(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
    @Request() req: any,
  ) {
    return this.composeStacks.setAutoDeploy(id, Boolean(body?.enabled), clerkId(req), userBag(req));
  }

  @Patch('compose-stacks/:id/name')
  async rename(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @Request() req: any,
  ) {
    return this.composeStacks.renameComposeStack(id, body?.name ?? '', clerkId(req), userBag(req));
  }

  @Delete('compose-stacks/:id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.composeStacks.deleteComposeStack(id, clerkId(req), userBag(req));
  }
}
