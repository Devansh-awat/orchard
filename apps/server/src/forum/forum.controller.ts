import {
  BadRequestException,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ForumService } from './forum.service';
import { UsersService } from '../users/users.service';
import { StorageService } from '../organizations/storage.service';
import { Auth, SuperAdmin } from '../auth/decorators';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

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
    private readonly storage: StorageService,
  ) {}

  private async requester(req: any): Promise<{ id: string; admin: boolean }> {
    const user = req.user.hackClubId
      ? await this.users.findByHackClubId(req.user.hackClubId)
      : await this.users.findByIdOrHackClubId(req.user.sub);
    if (!user) throw new UnauthorizedException('User not found');
    return { id: user.id, admin: !!user.isSuperAdmin };
  }

  private async userId(req: any): Promise<string> {
    return (await this.requester(req)).id;
  }

  @Auth()
  @Get('categories')
  listCategories() {
    return this.forum.listCategories();
  }

  @Auth()
  @Get('threads')
  async listThreads(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('sort') sort?: string,
  ) {
    return this.forum.listThreads({
      categorySlug: category || undefined,
      status: status || undefined,
      scope: scope || undefined,
      sort: sort || undefined,
      userId: await this.userId(req),
    });
  }

  @Auth()
  @Post('threads')
  async createThread(
    @Req() req: any,
    @Body()
    body: { categorySlug: string; title: string; body: string; scope?: string; images?: string[] },
  ) {
    return this.forum.createThread(await this.userId(req), body);
  }

  @Auth()
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(@Req() req: any, @UploadedFile() file?: Express.Multer.File) {
    await this.userId(req);
    if (!file) throw new BadRequestException('A file is required');
    if (!IMAGE_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, GIF, and WebP images are allowed');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Maximum file size is 5MB');
    }
    const url = await this.storage.uploadFile(file, 'forum');
    return { url };
  }

  @Auth()
  @Get('threads/:id')
  async getThread(@Req() req: any, @Param('id') id: string) {
    return this.forum.getThread(id, await this.userId(req));
  }

  @Auth()
  @Post('threads/:id/replies')
  async reply(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { body: string; images?: string[] },
  ) {
    return this.forum.createReply(await this.userId(req), id, body.body, body.images);
  }

  @Auth()
  @Delete('threads/:id')
  async deleteThread(@Req() req: any, @Param('id') id: string) {
    const u = await this.requester(req);
    return this.forum.deleteThread(id, u.id, u.admin);
  }

  @Auth()
  @Delete('threads/:id/replies/:replyId')
  async deleteReply(@Req() req: any, @Param('replyId') replyId: string) {
    const u = await this.requester(req);
    return this.forum.deleteReply(replyId, u.id, u.admin);
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
  @Patch('threads/:id/priority')
  setPriority(@Param('id') id: string, @Body() body: { priority: string }) {
    return this.forum.setPriority(id, body.priority);
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
