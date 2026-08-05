import {
  All,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth, RequireScope } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxesService, toSandboxDto } from './sandboxes.service';
import { SandboxChatService } from './sandbox-chat.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxConversationsService } from './sandbox-conversations.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxesController {
  constructor(
    private readonly sandboxes: SandboxesService,
    private readonly chat: SandboxChatService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly convos: SandboxConversationsService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
  ) {}

  private async resolveUser(req: any): Promise<{ id: string; email: string | null }> {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    if (this.analytics.configured && !(await this.analytics.isFeatureEnabled('greenhouse', user.id))) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    return { id: user.id, email: user.email ?? null };
  }

  @Get()
  async list(@Req() req: any) {
    const user = await this.resolveUser(req);
    return this.sandboxes.list(user.id);
  }

  @Post()
  async create(
    @Req() req: any,
    @Body()
    body: {
      name?: string;
      repoUrl?: string;
      sshIdentityId?: string;
      setupScript?: string | null;
    },
  ) {
    const user = await this.resolveUser(req);
    return this.sandboxes.create(user.id, user.email, body || {});
  }

  @Get('credentials')
  async getCredentials(@Req() req: any) {
    const user = await this.resolveUser(req);
    return this.sandboxes.getCredentialPresence(user.id);
  }

  @Put('credentials')
  async setCredentials(
    @Req() req: any,
    @Body() body: { claudeToken?: string | null; openaiToken?: string | null },
  ) {
    const user = await this.resolveUser(req);
    return this.sandboxes.setCredentials(user.id, user.email, body || {});
  }

  @Get(':id/changes')
  @RequireScope('exec')
  async changes(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('repo') repo?: string,
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.workspace.changes(row, repo || undefined);
  }

  @Get(':id/diff')
  @RequireScope('exec')
  async diff(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('file') file?: string,
    @Query('repo') repo?: string,
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.workspace.diff(row, file || undefined, repo || undefined);
  }

  @Get(':id/repos')
  @RequireScope('exec')
  async listRepos(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.workspace.listRepos(row);
  }

  @Post(':id/repos')
  @RequireScope('deploy')
  async addRepo(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repoUrl?: string },
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.workspace.addRepo(row, body?.repoUrl || '');
  }

  @Get(':id/conversations')
  async listConversations(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return { conversations: await this.convos.list(row.id) };
  }

  @Post(':id/conversations')
  async createConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { title?: string; repo?: string | null },
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.convos.create(row, body || {});
  }

  @Patch(':id/conversations/:cid')
  async updateConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() body: { title?: string; repo?: string | null },
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.convos.update(row.id, cid, body || {});
  }

  @Delete(':id/conversations/:cid')
  async removeConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    await this.convos.remove(row.id, cid);
    return { success: true };
  }

  @Get(':id/conversations/:cid/history')
  @RequireScope('exec')
  async conversationHistory(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    return this.convos.history(row, cid);
  }

  @Post(':id/chat')
  @RequireScope('exec')
  async chatStream(
    @Req() req: any,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string; conversationId?: string; repo?: string },
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    await this.chat.stream(
      row,
      body?.message ?? '',
      { conversationId: body?.conversationId || undefined, repo: body?.repo || undefined },
      res,
    );
  }

  @All(':id/opencode/*')
  @RequireScope('exec')
  async opencodeProxy(
    @Req() req: any,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = await this.resolveUser(req);
    const row = await this.sandboxes.getOwned(id, user.id);
    await this.workspace.proxyOpencode(row, req, res);
  }

  @Get(':id/ssh')
  @RequireScope('exec')
  async ssh(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    await this.sandboxes.getOwned(id, user.id);
    throw new HttpException('This endpoint requires a WebSocket upgrade', 426);
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    return toSandboxDto(await this.sandboxes.getOwned(id, user.id));
  }

  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      name?: string;
      sshIdentityId?: string;
      setupScript?: string | null;
    },
  ) {
    const user = await this.resolveUser(req);
    return this.sandboxes.update(id, user.id, user.email, body || {});
  }

  @Post(':id/start')
  async start(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    return this.sandboxes.start(id, user.id, user.email);
  }

  @Post(':id/stop')
  async stop(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    return this.sandboxes.stop(id, user.id, user.email);
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    await this.sandboxes.remove(id, user.id, user.email);
    return { success: true };
  }
}
