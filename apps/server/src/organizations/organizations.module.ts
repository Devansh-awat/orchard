import { OrganizationRegistryCredentialsController } from './organization-registry-credentials.controller';
import { RegistryCredentialsModule } from '../projects/registry-credentials.module';
import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { InvitationsController } from './invitations.controller';
import { OrganizationsService } from './organizations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { StorageService } from './storage.service';
import { TailscaleModule } from '../tailscale/tailscale.module';

@Module({
  imports: [RegistryCredentialsModule, PrismaModule, AuthModule, UsersModule, TailscaleModule],
  controllers: [
    OrganizationRegistryCredentialsController,
    OrganizationsController,
    InvitationsController
  ],
  providers: [OrganizationsService, StorageService],
  exports: [OrganizationsService, StorageService]
})
export class OrganizationsModule {}
