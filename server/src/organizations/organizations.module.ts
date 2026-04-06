import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { InvitationsController } from './invitations.controller';
import { OrganizationsService } from './organizations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { StorageService } from './storage.service';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService, StorageService],
  exports: [OrganizationsService, StorageService]
})
export class OrganizationsModule {}

