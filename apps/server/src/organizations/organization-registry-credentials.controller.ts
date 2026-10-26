import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Request,
  NotFoundException
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import {
  RegistryCredentialInput,
  RegistryCredentialsService
} from '../projects/registry-credentials.service';

@Auth()
@Controller('organizations/:organizationId/registry-credentials')
export class OrganizationRegistryCredentialsController {
  constructor(
    private readonly credentials: RegistryCredentialsService,
    private readonly users: UsersService,
    private readonly authz: AuthorizationService
  ) {}

  private async requireAdmin(organizationId: string, req: any) {
    const user = await this.users.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireOrgAdmin(organizationId, user.id);
    return user.id;
  }

  @Get()
  async list(@Param('organizationId') organizationId: string, @Request() req) {
    await this.requireAdmin(organizationId, req);
    return this.credentials.listOrganization(organizationId);
  }

  @Put()
  async upsert(
    @Param('organizationId') organizationId: string,
    @Body() body: RegistryCredentialInput,
    @Request() req
  ) {
    const userId = await this.requireAdmin(organizationId, req);
    return this.credentials.upsert(organizationId, body, userId, true);
  }

  @Delete(':id')
  async remove(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Request() req
  ) {
    const userId = await this.requireAdmin(organizationId, req);
    return this.credentials.removeOrganization(organizationId, id, userId);
  }
}
