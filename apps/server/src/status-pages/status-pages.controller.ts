import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth, Public } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { StatusPagesService, type StatusPageInput } from './status-pages.service';

// Public and unauthenticated on purpose: a status page is for the people
// who cannot log in. It has no api token to key the throttler on, so the
// per-IP bucket is tightened here rather than left at the API-wide default,
// and every render is cached for a few seconds behind that.
@Controller('status')
export class PublicStatusController {
  constructor(private readonly pages: StatusPagesService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Header('Cache-Control', 'public, max-age=15')
  @Get('resolve')
  async resolve(@Query('host') host: string) {
    const found = await this.pages.resolveHost(host ?? '');
    if (!found) throw new NotFoundException('No status page on this host');
    return found;
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Header('Cache-Control', 'public, max-age=15')
  @Get(':slug')
  async show(@Param('slug') slug: string) {
    const page = await this.pages.render(String(slug || '').toLowerCase());
    if (!page) throw new NotFoundException('Status page not found');
    return page;
  }
}

@Auth()
@Controller('organizations')
export class StatusPagesController {
  constructor(
    private readonly pages: StatusPagesService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService
  ) {}

  private async requireAdmin(organizationId: string, req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username
    });
    if (!user) throw new NotFoundException('User not found');
    await this.organizationsService.checkPermission(organizationId, user.id, 'admin');
    return user;
  }

  @Get(':id/status-pages')
  async list(@Param('id') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    return this.pages.list(organizationId);
  }

  @Get(':id/status-pages/options')
  async options(@Param('id') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    return this.pages.options(organizationId);
  }

  @Post(':id/status-pages')
  async create(@Param('id') organizationId: string, @Body() body: StatusPageInput, @Request() req) {
    const user = await this.requireAdmin(organizationId, req);
    return this.pages.create(organizationId, body ?? {}, user);
  }

  @Patch(':id/status-pages/:pageId')
  async update(
    @Param('id') organizationId: string,
    @Param('pageId') pageId: string,
    @Body() body: StatusPageInput,
    @Request() req
  ) {
    const user = await this.requireAdmin(organizationId, req);
    return this.pages.update(organizationId, pageId, body ?? {}, user);
  }

  @Delete(':id/status-pages/:pageId')
  async remove(
    @Param('id') organizationId: string,
    @Param('pageId') pageId: string,
    @Request() req
  ) {
    const user = await this.requireAdmin(organizationId, req);
    return this.pages.remove(organizationId, pageId, user);
  }
}
