import {
  All,
  Body,
  Controller,
  BadRequestException,
  ConflictException,
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
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth, RequireScope } from '@orchard/graft-sdk/server';
import { UsersService } from '../core/users.service';
import { AnalyticsService } from '../core/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxesService, withRole } from './sandboxes.service';
import { SandboxChatService } from './sandbox-chat.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxConversationsService } from './sandbox-conversations.service';
import { SandboxConnectService } from './sandbox-connect.service';
import { requireSandboxAccess } from './sandbox-role-gate';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxMembersService } from './sandbox-members.service';
import { SandboxGitActorService } from './sandbox-git-identity';
import {
  OPENCODE_MESSAGE_ID_RE,
  newOpencodeMessageId,
  opencodeMinRole,
  opencodePromptTarget,
  opencodeReplyTarget,
  opencodeSuffixOf
} from './sandbox-opencode-policy';

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
    private readonly gitActors: SandboxGitActorService,
    private readonly connect: SandboxConnectService,
    private readonly access: SandboxAccessService,
    private readonly members: SandboxMembersService
  ) {}

  private async resolveUser(req: any): Promise<{ id: string; email: string | null }> {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    return { id: user.id, email: user.email ?? null };
  }

  @Get()
  async list(@Req() req: any, @Query('organizationId') organizationId?: string) {
    const user = await this.resolveUser(req);
    return this.sandboxes.list(user.id, organizationId || undefined);
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
      organizationId?: string;
      runner?: string;
    }
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
    @Body() body: { claudeToken?: string | null; openaiToken?: string | null }
  ) {
    const user = await this.resolveUser(req);
    return this.sandboxes.setCredentials(user.id, user.email, body || {});
  }

  @Get(':id/boot')
  @RequireScope('exec')
  async bootStatus(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'viewer', { orgAdmin: true });
    return this.workspace.bootStatus(access.sandbox);
  }

  @Get(':id/changes')
  @RequireScope('exec')
  async changes(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('repo') repo?: string,
    @Query('session') session?: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.workspace.changes(row, { repo, session });
  }

  @Get(':id/diff')
  @RequireScope('exec')
  async diff(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('file') file?: string,
    @Query('repo') repo?: string,
    @Query('session') session?: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.workspace.diff(row, file || undefined, { repo, session });
  }

  @Get(':id/repos')
  @RequireScope('exec')
  async listRepos(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.workspace.listRepos(row);
  }

  @Post(':id/repos')
  @RequireScope('deploy')
  async addRepo(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repoUrl?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'owner');
    return this.workspace.addRepo(row, body?.repoUrl || '', user.id);
  }

  @Post(':id/repos/init')
  @RequireScope('exec')
  async initRepo(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.initRepo(row, body?.name || '', user.id);
  }

  @Put(':id/repos/:name/icon')
  @RequireScope('deploy')
  async setRepoIcon(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Body() body: { icon?: unknown }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    if (!body || typeof body !== 'object' || !('icon' in body)) {
      throw new BadRequestException('icon is required; send null to clear it');
    }
    return this.workspace.setRepoIcon(row, name, body.icon);
  }

  @Get(':id/conversations')
  async listConversations(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return { conversations: await this.convos.list(row.id) };
  }

  @Post(':id/conversations')
  async createConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { title?: string; repo?: string | null }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.convos.create(row, body || {});
  }

  @Patch(':id/conversations/:cid')
  async updateConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() body: { title?: string; repo?: string | null }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.convos.update(row.id, cid, body || {});
  }

  @Delete(':id/conversations/:cid')
  async removeConversation(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    await this.convos.remove(row.id, cid);
    return { success: true };
  }

  @Get(':id/conversations/:cid/history')
  @RequireScope('exec')
  async conversationHistory(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.convos.history(row, cid);
  }

  @Post(':id/chat')
  @RequireScope('exec')
  async chatStream(
    @Req() req: any,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string; conversationId?: string; repo?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    await this.chat.stream(
      row,
      body?.message ?? '',
      { conversationId: body?.conversationId || undefined, repo: body?.repo || undefined },
      res
    );
  }

  @Post(':id/git/commit')
  @RequireScope('exec')
  async gitCommit(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      repo?: string;
      session?: string;
      message?: string;
      files?: string[];
      amend?: boolean;
      signoff?: boolean;
      trackedOnly?: boolean;
    }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    const coAuthors =
      typeof body?.session === 'string' && body.session
        ? await this.members.coAuthors(row.id, body.session, user.id).catch(() => [])
        : [];
    const trailers = coAuthors.map((a) => `Co-authored-by: ${a.name} <${a.email}>`);
    const message = body?.message || '';
    return this.workspace.gitCommit(
      row,
      { repo: body?.repo, session: body?.session },
      message && trailers.length ? `${message.trimEnd()}\n\n${trailers.join('\n')}` : message,
      body?.files,
      user.id,
      { amend: body?.amend, signoff: body?.signoff, trackedOnly: body?.trackedOnly }
    );
  }

  @Post(':id/git/uncommit')
  @RequireScope('exec')
  async gitUncommit(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repo?: string; session?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitUncommit(row, { repo: body?.repo, session: body?.session }, user.id);
  }

  @Post(':id/git/push')
  @RequireScope('exec')
  async gitPush(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repo?: string; session?: string; force?: boolean }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitPush(row, { repo: body?.repo, session: body?.session }, user.id, {
      force: body?.force
    });
  }

  @Post(':id/git/fetch')
  @RequireScope('exec')
  async gitFetch(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repo?: string; session?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitFetch(row, { repo: body?.repo, session: body?.session }, user.id);
  }

  @Post(':id/git/pull')
  @RequireScope('exec')
  async gitPull(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repo?: string; session?: string; rebase?: boolean }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitPull(row, { repo: body?.repo, session: body?.session }, user.id, {
      rebase: body?.rebase
    });
  }

  @Get(':id/git/branches')
  @RequireScope('exec')
  async gitBranches(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('repo') repo?: string,
    @Query('session') session?: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.workspace.gitBranches(row, { repo, session });
  }

  @Get(':id/git/identity')
  async gitIdentity(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'viewer');
    const identity = await this.gitActors.describe(user.id);
    const canWrite = access.role === 'owner' || access.role === 'collaborator';
    return { ...identity, canCommit: canWrite, canPush: canWrite && identity.githubLinked };
  }

  @Post(':id/git/checkout')
  @RequireScope('exec')
  async gitCheckout(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      repo?: string;
      session?: string;
      branch?: string;
      create?: boolean;
      from?: string;
    }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitCheckout(
      row,
      { repo: body?.repo, session: body?.session },
      body?.branch || '',
      {
        create: body?.create,
        from: body?.from
      }
    );
  }

  @Post(':id/git/branch/delete')
  @RequireScope('exec')
  async gitDeleteBranch(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      repo?: string;
      session?: string;
      branch?: string;
      remote?: boolean;
      force?: boolean;
    }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.gitDeleteBranch(
      row,
      { repo: body?.repo, session: body?.session },
      body?.branch || '',
      user.id,
      {
        remote: body?.remote,
        force: body?.force
      }
    );
  }

  @Post(':id/git/pr')
  @RequireScope('exec')
  async gitPr(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      repo?: string;
      session?: string;
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
    }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.createPullRequest(
      row,
      { repo: body?.repo, session: body?.session },
      user.id,
      body || {}
    );
  }

  @Get(':id/file')
  @RequireScope('exec')
  async readFile(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('path') path?: string,
    @Query('repo') repo?: string,
    @Query('session') session?: string,
    @Query('ref') ref?: string
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'viewer');
    return this.workspace.readFile(row, { repo, session }, path || '', ref || undefined);
  }

  @Put(':id/file')
  @RequireScope('exec')
  async writeFile(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { repo?: string; session?: string; path?: string; content?: string }
  ) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'collaborator');
    return this.workspace.writeFile(
      row,
      { repo: body?.repo, session: body?.session },
      body?.path || '',
      body?.content ?? ''
    );
  }

  @All(':id/opencode/{*splat}')
  @RequireScope('exec')
  async opencodeProxy(
    @Req() req: any,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    const user = await this.resolveUser(req);
    const suffix = opencodeSuffixOf(req.originalUrl || '');
    const row = await requireSandboxAccess(
      this.access,
      id,
      user.id,
      opencodeMinRole(req.method, suffix)
    );
    const prompt = opencodePromptTarget(req.method, suffix);
    if (prompt) {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new BadRequestException('Prompt body must be a JSON object');
      }
      const given = req.body.messageID;
      if (
        given !== undefined &&
        (typeof given !== 'string' || !OPENCODE_MESSAGE_ID_RE.test(given))
      ) {
        throw new BadRequestException('messageID is not a valid opencode message id');
      }
      const messageId = typeof given === 'string' ? given : newOpencodeMessageId();
      req.body.messageID = messageId;
      const directory = typeof req.query?.directory === 'string' ? req.query.directory : null;
      const recorded = await this.members.recordPrompt({
        sandboxId: row.id,
        userId: user.id,
        chatId: prompt.chatId,
        messageId,
        directory
      });
      if (!recorded) throw new ConflictException('That message id is already in use');
    }
    const reply = opencodeReplyTarget(req.method, suffix);
    await this.workspace.proxyOpencode(row, req, res);
    if (reply && res.statusCode >= 200 && res.statusCode < 300) {
      void this.members
        .recordAnswer({ sandboxId: row.id, userId: user.id, ...reply })
        .catch(() => null);
    }
  }

  @Get(':id/ssh')
  @RequireScope('exec')
  async ssh(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    await requireSandboxAccess(this.access, id, user.id, 'owner');
    throw new HttpException('This endpoint requires a WebSocket upgrade', 426);
  }

  @Get(':id/hostkey')
  @RequireScope('exec')
  async hostKey(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'owner');
    return this.connect.hostKeys(row);
  }

  @Get(':id/connect')
  async connectInfo(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'owner');
    return this.connect.connectInfo(row);
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'viewer', { orgAdmin: true });
    return withRole(await this.sandboxes.dto(access.sandbox), access.role);
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
    }
  ) {
    const user = await this.resolveUser(req);
    await this.access.requireSandboxRole(id, user.id, 'owner');
    return this.sandboxes.update(id, user.id, user.email, body || {});
  }

  @Post(':id/start')
  async start(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'collaborator', {
      orgAdmin: true
    });
    return this.sandboxes.start(id, user.id, user.email, access.sandbox);
  }

  @Post(':id/apply/retry')
  async retryApply(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner', { orgAdmin: true });
    return this.sandboxes.retryApply(access.sandbox, user.id, user.email);
  }

  @Post(':id/stop')
  async stop(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner', { orgAdmin: true });
    return this.sandboxes.stop(id, user.id, user.email, access.sandbox);
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.resolveUser(req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner', { orgAdmin: true });
    await this.sandboxes.remove(id, user.id, user.email, access.sandbox);
    return { success: true };
  }
}
