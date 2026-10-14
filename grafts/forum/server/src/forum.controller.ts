import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  Auth,
  Doors,
  GraftUserId,
  SuperAdmin,
  type AuthDoor,
  type StorageDoor
} from '@orchardlabs/graft-sdk/server';
import { ForumService } from './forum.service';

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

const MAX_UPLOAD = 5 * 1024 * 1024;

type Upload = { buffer: Buffer; mimetype: string; size: number };

@Controller()
export class ForumController {
  constructor(
    private readonly forum: ForumService,
    @Inject(Doors.auth) private readonly auth: AuthDoor,
    @Inject(Doors.storage) private readonly storage: StorageDoor
  ) {}

  @Auth()
  @Get('categories')
  listCategories() {
    return this.forum.listCategories();
  }

  @Auth()
  @Get('threads')
  listThreads(
    @GraftUserId() userId: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('sort') sort?: string
  ) {
    return this.forum.listThreads({
      categorySlug: category || undefined,
      status: status || undefined,
      scope: scope || undefined,
      sort: sort || undefined,
      userId
    });
  }

  @Auth()
  @Post('threads')
  createThread(
    @GraftUserId() userId: string,
    @Body()
    body: { categorySlug: string; title: string; body: string; scope?: string; images?: string[] }
  ) {
    return this.forum.createThread(userId, body);
  }

  @Auth()
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  async uploadImage(@UploadedFile() file?: Upload) {
    if (!this.storage.configured) {
      throw new ServiceUnavailableException('Object storage is not configured on this instance');
    }
    if (!file) throw new BadRequestException('A file is required');
    const extension = IMAGE_TYPES[file.mimetype];
    if (!extension) {
      throw new BadRequestException('Only JPEG, PNG, GIF, and WebP images are allowed');
    }
    if (file.size > MAX_UPLOAD) throw new BadRequestException('Maximum file size is 5MB');
    const url = await this.storage.upload({
      data: file.buffer,
      contentType: file.mimetype,
      extension
    });
    return { url };
  }

  @Auth()
  @Get('threads/:id')
  getThread(@GraftUserId() userId: string, @Param('id') id: string) {
    return this.forum.getThread(id, userId);
  }

  @Auth()
  @Post('threads/:id/replies')
  reply(
    @GraftUserId() userId: string,
    @Param('id') id: string,
    @Body() body: { body: string; images?: string[] }
  ) {
    return this.forum.createReply(userId, id, body.body, body.images);
  }

  @Auth()
  @Delete('threads/:id')
  async deleteThread(@GraftUserId() userId: string, @Param('id') id: string) {
    return this.forum.deleteThread(id, userId, await this.auth.isSuperAdmin(userId));
  }

  @Auth()
  @Delete('threads/:id/replies/:replyId')
  async deleteReply(@GraftUserId() userId: string, @Param('replyId') replyId: string) {
    return this.forum.deleteReply(replyId, userId, await this.auth.isSuperAdmin(userId));
  }

  @Auth()
  @Post('threads/:id/vote')
  vote(@GraftUserId() userId: string, @Param('id') id: string) {
    return this.forum.setVote(userId, id, true);
  }

  @Auth()
  @Delete('threads/:id/vote')
  unvote(@GraftUserId() userId: string, @Param('id') id: string) {
    return this.forum.setVote(userId, id, false);
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
