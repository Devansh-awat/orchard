import {
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ForumService } from './forum.service';
import { UsersService } from '../users/users.service';
import { Auth, SuperAdmin } from '../auth/decorators';

@Injectable()
export class GroveEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.GROVE_ENABLED !== 'true') throw new NotFoundException();
    return true;
  }
}

@UseGuards(GroveEnabledGuard)
@Controller('forum')
export class ForumController {
  constructor(
    private readonly forum: ForumService,
    private readonly users: UsersService,
  ) {}

  private async userId(req: any): Promise<string> {
    const user = req.user.hackClubId
      ? await this.users.findByHackClubId(req.user.hackClubId)
      : await this.users.findByIdOrHackClubId(req.user.sub);
    if (!user) throw new UnauthorizedException('User not found');
    return user.id;
  }

  @Auth()
  @Get('categories')
  listCategories() {
    return this.forum.listCategories();
  }

  @Auth()
  @Get('threads')
  async listThreads(@Req() req: any, @Query('category') category?: string, @Query('sort') sort?: string) {
    return this.forum.listThreads({
      categorySlug: category || undefined,
      sort: sort || undefined,
      userId: await this.userId(req),
    });
  }

  @Auth()
  @Post('threads')
  async createThread(
    @Req() req: any,
    @Body() body: { categorySlug: string; title: string; body: string },
  ) {
    return this.forum.createThread(await this.userId(req), body);
  }

  @Auth()
  @Get('threads/:id')
  async getThread(@Req() req: any, @Param('id') id: string) {
    return this.forum.getThread(id, await this.userId(req));
  }

  @Auth()
  @Post('threads/:id/replies')
  async reply(@Req() req: any, @Param('id') id: string, @Body() body: { body: string }) {
    return this.forum.createReply(await this.userId(req), id, body.body);
  }

  @Auth()
  @Post('threads/:id/vote')
  async vote(@Req() req: any, @Param('id') id: string) {
    return this.forum.setVote(await this.userId(req), id, true);
  }

  @Auth()
  @Delete('threads/:id/vote')
  async unvote(@Req() req: any, @Param('id') id: string) {
    return this.forum.setVote(await this.userId(req), id, false);
  }

  @SuperAdmin()
  @Patch('threads/:id/status')
  setStatus(@Param('id') id: string, @Body() body: { status: string }) {
    return this.forum.setStatus(id, body.status);
  }

  @SuperAdmin()
  @Patch('threads/:id/pinned')
  setPinned(@Param('id') id: string, @Body() body: { pinned: boolean }) {
    return this.forum.setPinned(id, !!body.pinned);
  }

  @SuperAdmin()
  @Patch('threads/:id/locked')
  setLocked(@Param('id') id: string, @Body() body: { locked: boolean }) {
    return this.forum.setLocked(id, !!body.locked);
  }
}
