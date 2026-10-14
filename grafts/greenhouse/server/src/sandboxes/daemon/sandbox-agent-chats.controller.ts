import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth, RequireScope } from '@orchardlabs/graft-sdk/server';
import { UsersService } from '../../core/users.service';
import { RateLimitService } from '../../core/rate-limit.service';
import { AnalyticsService } from '../../core/analytics.service';
import { SandboxEnabledGuard } from '../sandbox-enabled.guard';
import { SandboxAccessService } from '../sandbox-access.service';
import { requireSandboxAccess, type SandboxAccessLevel } from '../sandbox-role-gate';
import { SandboxAgentHostService } from './sandbox-agent-host.service';

const STREAM_PING_MS = 20_000;

function sinceOf(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxAgentChatsController {
  constructor(
    private readonly accessService: SandboxAccessService,
    private readonly host: SandboxAgentHostService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly rateLimit?: RateLimitService
  ) {}

  private async access(req: any, id: string, level: SandboxAccessLevel) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    const row = await requireSandboxAccess(this.accessService, id, user.id, level);
    return { user, row };
  }

  @Get(':id/agents')
  async catalog(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('refresh') refresh?: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.host.catalog(row, refresh === '1');
  }

  @Get(':id/sessions/:sid/agent-chats')
  async list(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.host.listChats(row, sid);
  }

  @Post(':id/sessions/:sid/agent-chats')
  @RequireScope('exec')
  async create(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Body() body: Record<string, unknown>
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    if (body?.prompt) await this.rateLimit?.checkRateLimit(user.id, 'user', 'sandbox_prompt');
    return this.host.createChat(row, sid, user.id, body || {});
  }

  @Get(':id/sessions/:sid/agent-chats/:cid/events')
  async events(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Query('since') since?: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    return this.host.events(row, sid, cid, sinceOf(since));
  }

  @Get(':id/sessions/:sid/agent-chats/:cid/stream')
  async stream(
    @Req() req: any,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Query('since') since?: string
  ) {
    const { row } = await this.access(req, id, 'viewer');
    const controller = new AbortController();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.socket?.setNoDelay(true);
    res.flushHeaders?.();
    const ping = setInterval(() => res.write(': ping\n\n'), STREAM_PING_MS);
    const close = () => {
      clearInterval(ping);
      controller.abort();
    };
    req.on('close', close);
    try {
      await this.host.stream(
        row,
        sid,
        cid,
        sinceOf(since ?? req.headers['last-event-id']),
        (ev) => {
          res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
        },
        controller.signal
      );
      res.write(`event: ready\ndata: {}\n\n`);
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: e?.message || 'stream failed', status: e?.status ?? 500 })}\n\n`
      );
      close();
      res.end();
    }
  }

  @Post(':id/sessions/:sid/agent-chats/:cid/prompt')
  @RequireScope('exec')
  async prompt(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Body() body: Record<string, unknown>
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    await this.rateLimit?.checkRateLimit(user.id, 'user', 'sandbox_prompt');
    return this.host.prompt(row, sid, cid, user.id, body || {});
  }

  @Post(':id/sessions/:sid/agent-chats/:cid/cancel')
  @RequireScope('exec')
  async cancel(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    return this.host.cancel(row, sid, cid, user.id);
  }

  @Post(':id/sessions/:sid/agent-chats/:cid/permission')
  @RequireScope('exec')
  async permission(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Body() body: Record<string, unknown>
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    return this.host.answer(row, sid, cid, user.id, body || {});
  }

  @Post(':id/sessions/:sid/agent-chats/:cid/config')
  @RequireScope('exec')
  async config(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Body() body: Record<string, unknown>
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.host.setConfig(row, sid, cid, body || {});
  }

  @Post(':id/sessions/:sid/agent-chats/:cid/revert')
  @RequireScope('exec')
  async revert(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Body() body: Record<string, unknown>
  ) {
    const { user, row } = await this.access(req, id, 'collaborator');
    return this.host.revert(row, sid, cid, user.id, body || {});
  }

  @Patch(':id/sessions/:sid/agent-chats/:cid')
  @RequireScope('exec')
  async rename(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string,
    @Body() body: { title?: unknown }
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.host.renameChat(row, sid, cid, body?.title);
  }

  @Delete(':id/sessions/:sid/agent-chats/:cid')
  @RequireScope('exec')
  async remove(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Param('cid') cid: string
  ) {
    const { row } = await this.access(req, id, 'collaborator');
    return this.host.deleteChat(row, sid, cid);
  }
}
