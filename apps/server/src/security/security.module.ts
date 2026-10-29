import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability/observability.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { AttacksService } from './attacks.service';
import { HarborScanClient } from './harbor-scan.client';
import { SecurityService } from './security.service';
import { SecurityController } from './security.controller';

@Module({
  imports: [PrismaModule, AuthModule, ProjectsModule, ObservabilityModule, KubernetesModule],
  controllers: [SecurityController],
  providers: [HarborScanClient, SecurityService, AttacksService],
  exports: [SecurityService, AttacksService]
})
export class SecurityModule {}
