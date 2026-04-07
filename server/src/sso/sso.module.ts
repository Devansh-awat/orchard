import { Module } from '@nestjs/common';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { SsoConfigController } from './sso-config.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule],
  controllers: [SsoController, SsoConfigController],
  providers: [SsoService],
  exports: [SsoService],
})
export class SsoModule {}
