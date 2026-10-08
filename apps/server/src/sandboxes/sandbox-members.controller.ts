import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth, RequireScope } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService, SandboxMinRole } from './sandbox-access.service';
import { SandboxMembersService } from './sandbox-members.service';
import { SandboxPreviewService } from './preview/sandbox-preview.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxMembersController {
  constructor(
    private readonly accessService: SandboxAccessService,
    private readonly members: SandboxMembersService,
    private readonly previews: SandboxPreviewService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private async access(req: any, id: string, min: SandboxMinRole) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    const access = await this.accessService.requireSandboxRole(id, user.id, min);
    return { actor: { id: user.id, email: user.email ?? null }, access };
  }

  @Get(':id/members')
  async list(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { access } = await this.access(req, id, 'viewer');
    return this.members.list(access);
  }

  @Post(':id/members')
  async add(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { userId?: string; email?: string; role?: string }
  ) {
    const { actor, access } = await this.access(req, id, 'owner');
    return this.members.add(access, actor, body || {});
  }

  @Patch(':id/members/:userId')
  async update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: { role?: string }
  ) {
    const { actor, access } = await this.access(req, id, 'owner');
    return this.members.update(access, actor, userId, body || {});
  }

  @Delete(':id/members/:userId')
  async remove(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string
  ) {
    const { actor, access } = await this.access(req, id, 'viewer');
    await this.members.remove(access, actor, userId);
    return { success: true };
  }

  @Get(':id/sessions/:sid/comments')
  async comments(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('since') since?: string
  ) {
    const { access } = await this.access(req, id, 'viewer');
    return this.members.listComments(access.sandbox.id, sid, since || undefined);
  }

  @Post(':id/sessions/:sid/comments')
  async comment(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { chatId?: string; body?: string }
  ) {
    const { actor, access } = await this.access(req, id, 'collaborator');
    return this.members.createComment(access.sandbox.id, sid, actor.id, body || {});
  }

  @Get(':id/sessions/:sid/authors')
  async authors(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { access } = await this.access(req, id, 'viewer');
    return this.members.authors(access.sandbox.id, sid);
  }

  @Get(':id/preview-token')
  @RequireScope('exec')
  async previewToken(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('port') port?: string
  ) {
    const parsed = Number(port);
    if (!port || !Number.isInteger(parsed)) throw new BadRequestException('port is required');
    const { access } = await this.access(req, id, 'viewer');
    return this.previews.link(access, parsed);
  }
}
