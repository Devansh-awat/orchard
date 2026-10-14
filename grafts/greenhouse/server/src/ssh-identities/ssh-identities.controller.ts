import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req
} from '@nestjs/common';
import { Auth } from '@orchardlabs/graft-sdk/server';
import { UsersService } from '../core/users.service';
import { AnalyticsService } from '../core/analytics.service';
import { SshIdentitiesService } from './ssh-identities.service';

@Auth()
@Controller('ssh-identities')
export class SshIdentitiesController {
  constructor(
    private readonly identities: SshIdentitiesService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService
  ) {}

  private async userId(req: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    if (
      this.analytics.configured &&
      !(await this.analytics.isFeatureEnabled('greenhouse', user.id))
    ) {
      throw new NotFoundException('Sandbox feature is not enabled for your account');
    }
    return user.id;
  }

  @Get()
  async list(@Req() req: any) {
    return { identities: await this.identities.list(await this.userId(req)) };
  }

  @Post()
  async create(@Req() req: any, @Body() body: { name?: string; publicKey?: string }) {
    return this.identities.create(await this.userId(req), body || {});
  }

  @Post('import-github')
  async importGithub(@Req() req: any) {
    return { identities: await this.identities.importFromGithub(await this.userId(req)) };
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.identities.remove(id, await this.userId(req));
    return { success: true };
  }
}
