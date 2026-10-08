import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxShareLinksService } from './sandbox-share-links.service';
import { resolveGreenhouseUser } from './sandbox-greenhouse-user';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxShareLinksController {
  constructor(
    private readonly access: SandboxAccessService,
    private readonly shares: SandboxShareLinksService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  @Get(':id/share-links')
  async list(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner');
    return this.shares.list(access.sandbox.id);
  }

  @Post(':id/share-links')
  async create(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { sessionId?: string | null; expiresInHours?: number }
  ) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner');
    return this.shares.create(access, { id: user.id, email: user.email ?? null }, body || {});
  }

  @Delete(':id/share-links/:linkId')
  async revoke(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string
  ) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    const access = await this.access.requireSandboxRole(id, user.id, 'owner');
    return this.shares.revoke(access, { id: user.id, email: user.email ?? null }, linkId);
  }
}

@Auth()
@UseGuards(SandboxEnabledGuard)
@Throttle({ default: { ttl: 60_000, limit: 60 } })
@Controller('share/sandbox')
export class SandboxShareViewerController {
  constructor(
    private readonly shares: SandboxShareLinksService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private async viewer(req: any) {
    const user = await resolveGreenhouseUser(this.usersService, this.analytics, req);
    return { id: user.id, email: user.email ?? null };
  }

  @Get(':token')
  async view(@Req() req: any, @Param('token') token: string) {
    return this.shares.view(token, await this.viewer(req));
  }

  @Get(':token/sessions/:sid/transcript')
  async transcript(
    @Req() req: any,
    @Param('token') token: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('limit') limit?: string
  ) {
    return this.shares.transcript(token, await this.viewer(req), sid, limit);
  }

  @Get(':token/sessions/:sid/changes')
  async changes(
    @Req() req: any,
    @Param('token') token: string,
    @Param('sid', ParseUUIDPipe) sid: string
  ) {
    return this.shares.changes(token, await this.viewer(req), sid);
  }

  @Get(':token/sessions/:sid/diff')
  async diff(
    @Req() req: any,
    @Param('token') token: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('file') file?: string
  ) {
    return this.shares.diff(token, await this.viewer(req), sid, file);
  }
}
