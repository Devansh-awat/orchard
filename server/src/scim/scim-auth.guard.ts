import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { ScimTokensService } from './scim-tokens.service';

// Request property the guard populates; SCIM handlers read it to scope every
// operation to the bearer token's org.
export const SCIM_ORG_KEY = 'scimOrgId';

function scimUnauthorized(res: Response): HttpException {
  res.setHeader('WWW-Authenticate', 'Bearer realm="SCIM"');
  return new HttpException(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'Invalid or missing SCIM bearer token',
    },
    401,
  );
}

@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly scimTokens: ScimTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw scimUnauthorized(res);
    }

    const organizationId = await this.scimTokens.resolveOrganization(header.slice(7).trim());
    if (!organizationId) {
      throw scimUnauthorized(res);
    }

    req[SCIM_ORG_KEY] = organizationId;
    return true;
  }
}
