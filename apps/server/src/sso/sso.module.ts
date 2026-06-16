import { Module } from '@nestjs/common';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { SsoConfigController } from './sso-config.controller';
import { OidcStateStore } from './oidc-state.store';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule, KubernetesModule],
  controllers: [SsoController, SsoConfigController],
  providers: [SsoService, OidcStateStore],
  exports: [SsoService],
})
export class SsoModule {}
