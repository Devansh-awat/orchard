import { Module } from '@nestjs/common';
import { SsoService } from './sso.service';
import { SsoLoginService } from './sso-login.service';
import { SsoCryptoService } from './sso-crypto.service';
import { OrgDomainsService } from './org-domains.service';
import { OrgDomainRecheckService } from './org-domain-recheck.service';
import { OrgIdentityService } from './org-identity.service';
import { SsoController } from './sso.controller';
import { AccountLinksController } from './account-links.controller';
import { SsoAdminController } from './sso-admin.controller';
import { SsoInstanceController } from './sso-instance.controller';
import { VanityDomainService } from './vanity-domain.service';
import { VanityDomainController } from './vanity-domain.controller';
import { IdentityMappingService } from './identity-mapping.service';
import { InstanceIdentityService } from './instance-identity.service';
import { OidcStateStore } from './oidc-state.store';
import { SamlRequestStore } from './saml-request.store';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule, KubernetesModule],
  controllers: [
    SsoController,
    SsoAdminController,
    SsoInstanceController,
    VanityDomainController,
    AccountLinksController
  ],
  providers: [
    SsoService,
    SsoLoginService,
    SsoCryptoService,
    OrgDomainsService,
    OrgDomainRecheckService,
    OrgIdentityService,
    IdentityMappingService,
    InstanceIdentityService,
    VanityDomainService,
    OidcStateStore,
    SamlRequestStore
  ],
  exports: [SsoService, OrgDomainsService, IdentityMappingService, OrgIdentityService]
})
export class SsoModule {}
