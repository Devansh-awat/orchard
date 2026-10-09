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
  Optional,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth, RequireScope } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxSessionsService } from './sandbox-sessions.service';
import { SandboxGitActorService } from './sandbox-git-identity';
import { requireSandboxAccess, type SandboxAccessLevel } from './sandbox-role-gate';
import type { FsOp } from './sandbox-session-commands';

type FsBody = { session?: string | null; repo?: string; path?: string; to?: string };

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxSessionsController {
  constructor(
    private readonly accessService: SandboxAccessService,
    private readonly sessions: SandboxSessionsService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
    private readonly gitActors: SandboxGitActorService,
    @Optional() private readonly rateLimit?: RateLimitService
  ) {}

  private async resolveUser(req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    return user;
  }

  private async access(req: any, id: string, level: SandboxAccessLevel) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.accessService, id, user.id, level);
    return { user, row };
  }

  @Get(':id/sessions')
  async list(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeArchived') includeArchived?: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.sessions.list(row, { includeArchived: truthy(includeArchived) });
  }

  @Post(':id/sessions')
  @RequireScope('exec')
  async create(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      repo?: string;
      baseBranch?: string | null;
      title?: string;
      prompt?: string;
      issue?: { provider?: string; ref?: string };
      branchPrefix?: string;
    }
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    await this.rateLimit?.checkRateLimit(user.id, 'user', 'sandbox_session');
    return this.sessions.create(row, user.id, body || {});
  }

  @Get(':id/sessions/:sid')
  async get(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.sessions.get(row, sid);
  }

  @Patch(':id/sessions/:sid')
  @RequireScope('exec')
  async update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { title?: string; archived?: boolean; deleteBranch?: boolean }
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.sessions.update(row, sid, body || {});
  }

  @Delete(':id/sessions/:sid')
  @RequireScope('exec')
  async remove(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('deleteBranch') deleteBranch?: string
  ) {
    const deleting = truthy(deleteBranch);
    const { row } = await this.access(req, id, 'collaborator');
    await this.sessions.remove(row, sid, { deleteBranch: deleting });
    return { success: true };
  }

  @Delete(':id/repos/:name')
  @RequireScope('deploy')
  async removeRepo(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string
  ) {
    const { row } = await this.access(req, id, 'owner');
    return this.sessions.removeRepo(row, name);
  }

  @Get(':id/sessions/:sid/chats')
  @RequireScope('exec')
  async chats(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.sessions.chats(row, sid);
  }

  @Post(':id/sessions/:sid/chats')
  @RequireScope('exec')
  async createChat(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { title?: string }
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.sessions.createChat(row, sid, body || {});
  }

  @Delete(':id/sessions/:sid/chats/:chatId')
  @RequireScope('exec')
  async deleteChat(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('chatId') chatId: string
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.sessions.deleteChat(row, sid, chatId);
  }

  @Get(':id/sessions/:sid/scripts')
  @RequireScope('exec')
  async scripts(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.sessions.scripts(row, sid);
  }

  @Post(':id/sessions/:sid/run')
  @RequireScope('exec')
  async run(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { action?: string }
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.sessions.run(row, sid, body?.action);
  }

  @Get(':id/sessions/:sid/ports')
  @RequireScope('exec')
  async ports(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.sessions.ports(row, sid);
  }

  @Get(':id/sessions/:sid/checks')
  async checks(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { user, row } = await this.access(req, id, 'viewer');
    const actor = await this.gitActors.resolve(user.id).catch(() => null);
    return this.sessions.checks(row, sid, actor?.token ?? null);
  }

  @Post(':id/sessions/:sid/git/merge')
  @RequireScope('exec')
  async merge(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: { method?: string }
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    const token = await this.gitActors.requireActorToken(user.id);
    return this.sessions.merge(row, sid, token, body?.method);
  }

  private async fsOp(req: any, id: string, op: FsOp, body: FsBody) {
    if (body?.session !== undefined && body.session !== null && typeof body.session !== 'string') {
      throw new BadRequestException('session must be a string');
    }
    const { row } = await this.access(req, id, 'collaborator');
    return this.workspace.fsOp(row, op, body || {});
  }

  @Post(':id/fs/mkdir')
  @RequireScope('exec')
  async mkdir(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: FsBody) {
    return this.fsOp(req, id, 'mkdir', body);
  }

  @Post(':id/fs/rename')
  @RequireScope('exec')
  async rename(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: FsBody) {
    return this.fsOp(req, id, 'rename', body);
  }

  @Post(':id/fs/delete')
  @RequireScope('exec')
  async deletePath(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: FsBody) {
    return this.fsOp(req, id, 'delete', body);
  }
}
