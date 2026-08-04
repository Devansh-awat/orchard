import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { SshIdentitiesService } from './ssh-identities.service';

@Auth()
@Controller('ssh-identities')
export class SshIdentitiesController {
  constructor(
    private readonly identities: SshIdentitiesService,
    private readonly usersService: UsersService,
  ) {}

  private async userId(req: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
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
