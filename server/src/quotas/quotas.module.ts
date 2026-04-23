import { Module, forwardRef } from '@nestjs/common';
import { AdminQuotasController, OrgQuotasController } from './quotas.controller';
import { QuotasService } from './quotas.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, AuthModule, KubernetesModule, forwardRef(() => OrganizationsModule)],
  controllers: [AdminQuotasController, OrgQuotasController],
  providers: [QuotasService],
  exports: [QuotasService],
})
export class QuotasModule {}
