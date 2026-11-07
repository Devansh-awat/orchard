import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability/observability.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { RegistryCredentialsModule } from '../projects/registry-credentials.module';
import { AttacksService } from './attacks.service';
import { HarborScanClient } from './harbor-scan.client';
import { SecurityService } from './security.service';
import { SecurityController } from './security.controller';
import { TrivyScanService } from './trivy-scan.service';
import { ImageScanningController } from './image-scanning.controller';
import { ScanResultGuard } from './scan-result.guard';
import { ImageScanResultController } from './image-scan-result.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ProjectsModule,
    ObservabilityModule,
    KubernetesModule,
    RegistryCredentialsModule
  ],
  controllers: [SecurityController, ImageScanningController, ImageScanResultController],
  providers: [ScanResultGuard, HarborScanClient, TrivyScanService, SecurityService, AttacksService],
  exports: [SecurityService, AttacksService]
})
export class SecurityModule {}
