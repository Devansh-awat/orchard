import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SsoModule } from '../sso/sso.module';
import { ScimGroupsService } from './scim-groups.service';
import { ScimService } from './scim.service';
import { ScimController } from './scim.controller';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimTokensService } from './scim-tokens.service';
import { ScimTokensController } from './scim-tokens.controller';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, EmailModule, SsoModule],
  controllers: [ScimController, ScimTokensController],
  providers: [ScimService, ScimGroupsService, ScimTokensService, ScimAuthGuard],
  exports: [ScimTokensService]
})
export class ScimModule {}
