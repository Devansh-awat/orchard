import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards
} from '@nestjs/common';
import { Auth, RequireScope } from '../../auth/decorators';
import { UsersService } from '../../users/users.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { SandboxEnabledGuard } from '../sandbox-enabled.guard';
import { SandboxAccessService } from '../sandbox-access.service';
import { requireSandboxAccess } from '../sandbox-role-gate';
import { resolveGreenhouseUser } from '../sandbox-greenhouse-user';
import { UserContextService } from './user-context.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller()
export class UserContextController {
  constructor(
    private readonly context: UserContextService,
    private readonly access: SandboxAccessService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private user(req: any) {
    return resolveGreenhouseUser(this.usersService, this.analytics, req);
  }

  @Get('me/context')
  @RequireScope('read')
  async list(@Req() req: any) {
    return this.context.list((await this.user(req)).id);
  }

  @Get('me/context/:itemId')
  @RequireScope('exec')
  async get(@Req() req: any, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.context.get((await this.user(req)).id, itemId);
  }

  @Put('me/context')
  @RequireScope('deploy')
  async upsert(@Req() req: any, @Body() body: unknown) {
    return this.context.upsert((await this.user(req)).id, body);
  }

  @Post('me/context/import')
  @RequireScope('deploy')
  async import(@Req() req: any, @Body() body: unknown) {
    return this.context.import((await this.user(req)).id, body);
  }

  @Patch('me/context/:itemId')
  @RequireScope('deploy')
  async update(
    @Req() req: any,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: { enabled?: unknown }
  ) {
    return this.context.setEnabled((await this.user(req)).id, itemId, body?.enabled !== false);
  }

  @Delete('me/context/:itemId')
  @RequireScope('deploy')
  async remove(@Req() req: any, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.context.remove((await this.user(req)).id, itemId);
  }

  @Post('sandboxes/:id/context/sync')
  @RequireScope('exec')
  async sync(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.user(req);
    const row = await requireSandboxAccess(this.access, id, user.id, 'owner');
    return this.context.syncToSandbox(row);
  }
}
