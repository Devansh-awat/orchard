import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { ScimTokensService } from './scim-tokens.service';

@Auth()
@Controller('organizations')
export class ScimTokensController {
  constructor(
    private readonly scimTokens: ScimTokensService,
    private readonly authz: AuthorizationService,
  ) {}

  // The base URL an admin pastes into their IdP's SCIM connector. Tenant
  // endpoints are org-scoped via the bearer token, so the path is shared.
  private scimBaseUrl(req: Request, _organizationId: string): string {
    const configured = process.env.SCIM_BASE_URL;
    if (configured) return `${configured.replace(/\/$/, '')}`;
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    return `${proto}://${req.get('host')}/apiv1/scim/v2`;
  }

  @Get(':id/scim/tokens')
  async list(@Param('id') organizationId: string, @Req() req: Request) {
    await this.authz.requireOrgOwner(organizationId, req['auth'].userId);
    return {
      baseUrl: this.scimBaseUrl(req, organizationId),
      tokens: await this.scimTokens.list(organizationId),
    };
  }

  @Post(':id/scim/tokens')
  async create(
    @Param('id') organizationId: string,
    @Req() req: Request,
    @Body() body: { name: string; expiresAt?: string },
  ) {
    await this.authz.requireOrgOwner(organizationId, req['auth'].userId);
    const expiresAt = body?.expiresAt ? new Date(body.expiresAt) : undefined;
    const created = await this.scimTokens.create(
      organizationId,
      req['auth'].userId,
      body?.name,
      expiresAt,
    );
    return { ...created, baseUrl: this.scimBaseUrl(req, organizationId) };
  }

  @Delete(':id/scim/tokens/:tokenId')
  async revoke(
    @Param('id') organizationId: string,
    @Param('tokenId') tokenId: string,
    @Req() req: Request,
  ) {
    await this.authz.requireOrgOwner(organizationId, req['auth'].userId);
    const result = await this.scimTokens.revoke(organizationId, req['auth'].userId, tokenId);
    if (!result) {
      throw new NotFoundException('Token not found');
    }
    return { message: 'Token revoked' };
  }
}
