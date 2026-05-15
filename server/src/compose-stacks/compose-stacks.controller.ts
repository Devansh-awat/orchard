import { Controller, Get, Post, Put, Delete, Param, Body, Request } from '@nestjs/common';
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
  return req.user.hackClubId || req.user.sub;
}

@Auth()
@Controller()
export class ComposeStacksController {
  constructor(private readonly composeStacks: ComposeStacksService) {}

  @Post('projects/:projectId/compose-stacks')
  async create(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; composeYaml: string },
    @Request() req: any,
  ) {
    return this.composeStacks.createComposeStack(projectId, body, clerkId(req), userBag(req));
  }

  @Get('projects/:projectId/compose-stacks')
  async list(@Param('projectId') projectId: string, @Request() req: any) {
    return this.composeStacks.listForProject(projectId, clerkId(req), userBag(req));
  }

  @Get('compose-stacks/:id')
  async get(@Param('id') id: string, @Request() req: any) {
    return this.composeStacks.getComposeStack(id, clerkId(req), userBag(req));
  }

  @Put('compose-stacks/:id')
  async update(
    @Param('id') id: string,
    @Body() body: { composeYaml: string },
    @Request() req: any,
  ) {
    return this.composeStacks.updateComposeStack(id, body, clerkId(req), userBag(req));
  }

  @Delete('compose-stacks/:id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.composeStacks.deleteComposeStack(id, clerkId(req), userBag(req));
  }
}
