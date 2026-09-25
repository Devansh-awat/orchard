import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { GitConnectionsService, type GitConnectionInput } from './git-connections.service';

@Auth()
@Controller('users/me/git-connections')
export class GitConnectionsController {
  constructor(
    private readonly connections: GitConnectionsService,
    private readonly usersService: UsersService
  ) {}

  private async me(req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Get()
  async list(@Request() req) {
    const user = await this.me(req);
    return this.connections.list(user.id);
  }

  @Get('oauth')
  async oauth(@Request() req) {
    await this.me(req);
    return this.connections.oauthAvailable();
  }

  @Post()
  async create(@Body() body: GitConnectionInput, @Request() req) {
    const user = await this.me(req);
    return this.connections.create(user.id, body ?? {});
  }

  @Get(':connectionId/webhook-secret')
  async webhookSecret(@Param('connectionId') connectionId: string, @Request() req) {
    const user = await this.me(req);
    return { secret: await this.connections.webhookSecret(user.id, connectionId) };
  }

  @Patch(':connectionId')
  async update(
    @Param('connectionId') connectionId: string,
    @Body() body: GitConnectionInput,
    @Request() req
  ) {
    const user = await this.me(req);
    return this.connections.update(user.id, connectionId, body ?? {});
  }

  @Delete(':connectionId')
  async remove(@Param('connectionId') connectionId: string, @Request() req) {
    const user = await this.me(req);
    await this.connections.remove(user.id, connectionId);
    return { success: true };
  }

  @Get(':connectionId/repositories')
  async repos(@Param('connectionId') connectionId: string, @Request() req) {
    const user = await this.me(req);
    return this.connections.repos(user.id, connectionId);
  }

  @Get(':connectionId/branches')
  async branches(
    @Param('connectionId') connectionId: string,
    @Query('repo') repo: string,
    @Request() req
  ) {
    const user = await this.me(req);
    return this.connections.branches(user.id, connectionId, repo);
  }

  @Get(':connectionId/detect')
  async detect(
    @Param('connectionId') connectionId: string,
    @Query('repo') repo: string,
    @Query('branch') branch: string,
    @Request() req
  ) {
    const user = await this.me(req);
    return this.connections.detect(user.id, connectionId, repo, branch ?? '');
  }
}
