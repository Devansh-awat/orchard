import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Auth, RequireScope } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxesService, toSandboxDto } from './sandboxes.service';

@Auth()
@UseGuards(SandboxEnabledGuard)
@Controller('sandboxes')
export class SandboxesController {
  constructor(
    private readonly sandboxes: SandboxesService,
    private readonly usersService: UsersService,
  ) {}

  private async resolveUser(req: any): Promise<{ id: string; email: string | null }> {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
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
      sshPublicKeys?: string[];
      importGithubKeys?: boolean;
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
      sshPublicKeys?: string[];
      importGithubKeys?: boolean;
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
