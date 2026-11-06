import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  NotFoundException
} from '@nestjs/common';
import { Request } from 'express';
import { Auth } from './decorators';
import { ApiTokensService } from './api-tokens.service';

@Controller('auth/tokens')
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Auth()
  @Post()
  async create(
    @Req() req: Request,
    @Body() body: {
      name: string;
      expiresAt?: string;
      scopes?: string[];
      restrictedProjectIds?: string[];
    }
  ) {
    const auth = req['auth'] as {
      userId: string;
      apiTokenId?: string;
      tokenScopes?: string[];
      tokenProjectIds?: string[];
      sessionOrgId?: string;
    };
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    return this.apiTokensService.create(
      auth.userId,
      body.name,
      expiresAt,
      body.scopes,
      body.restrictedProjectIds,
      auth.apiTokenId
        ? {
            scopes: auth.tokenScopes ?? [],
            projectIds: auth.tokenProjectIds ?? [],
            tokenId: auth.apiTokenId
          }
        : undefined,
      auth.sessionOrgId
    );
  }

  @Auth()
  @Get()
  async list(@Req() req: Request) {
    const { userId, sessionOrgId } = req['auth'];
    return this.apiTokensService.list(userId, sessionOrgId);
  }

  @Auth()
  @Patch(':id')
  async rename(@Req() req: Request, @Param('id') id: string, @Body() body: { name?: string }) {
    const { userId, sessionOrgId } = req['auth'];
    const result = await this.apiTokensService.rename(userId, id, body?.name ?? '', sessionOrgId);
    if (!result) {
      throw new NotFoundException('Token not found');
    }
    return result;
  }

  @Auth()
  @Delete(':id')
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const { userId, sessionOrgId } = req['auth'];
    const result = await this.apiTokensService.revoke(userId, id, sessionOrgId);
    if (!result) {
      throw new NotFoundException('Token not found');
    }
    return { message: 'Token revoked' };
  }
}
