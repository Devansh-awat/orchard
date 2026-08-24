import { Controller, Patch, Param, Body, Request, NotFoundException } from '@nestjs/common';
import { VanityDomainService } from './vanity-domain.service';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';

@Auth()
@Controller('organizations')
export class VanityDomainController {
  constructor(
    private readonly vanity: VanityDomainService,
    private readonly authz: AuthorizationService,
    private readonly users: UsersService,
  ) {}

  @Patch(':id/subdomain')
  async setSubdomain(
    @Param('id') organizationId: string,
    @Body('subdomain') subdomain: string | null,
    @Request() req,
  ) {
    const user = await this.users.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
    });
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireOrgOwner(organizationId, user.id);
    return this.vanity.setSubdomain(organizationId, subdomain);
  }
}
