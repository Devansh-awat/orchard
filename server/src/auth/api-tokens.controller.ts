import { Controller, Post, Get, Delete, Body, Param, Req, NotFoundException } from '@nestjs/common';
import { Auth } from './decorators';
import { ApiTokensService } from './api-tokens.service';
import { Request } from 'express';

@Controller('auth/tokens')
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Auth()
  @Post()
  async create(
    @Req() req: Request,
    @Body() body: { name: string; expiresAt?: string; scopes?: string[] },
  ) {
    const userId = req['auth'].userId;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    return this.apiTokensService.create(userId, body.name, expiresAt, body.scopes);
  }

  @Auth()
  @Get()
  async list(@Req() req: Request) {
    const userId = req['auth'].userId;
    return this.apiTokensService.list(userId);
  }

  @Auth()
  @Delete(':id')
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const userId = req['auth'].userId;
    const result = await this.apiTokensService.revoke(userId, id);
    if (!result) {
      throw new NotFoundException('Token not found');
    }
    return { message: 'Token revoked' };
  }
}
