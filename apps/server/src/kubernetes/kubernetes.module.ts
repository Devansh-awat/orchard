import { Module } from '@nestjs/common';
import { KubernetesController } from './kubernetes.controller';
import { KubernetesService } from './kubernetes.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { K8sWorkloadService } from './k8s-workload.service';
import { K8sNetworkService } from './k8s-network.service';
import { K8sNamespaceService } from './k8s-namespace.service';
import { R2ProxyService } from './r2-proxy.service';
import { BackupUpstreamSyncService } from './backup-upstream-sync.service';
import { PostgresImageService } from './postgres-image.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [KubernetesController],
  providers: [
    KubernetesService,
    K8sCnpgService,
    K8sWorkloadService,
    K8sNetworkService,
    K8sNamespaceService,
    R2ProxyService,
    BackupUpstreamSyncService,
    PostgresImageService
  ],
  exports: [
    KubernetesService,
    K8sCnpgService,
    K8sWorkloadService,
    K8sNetworkService,
    K8sNamespaceService,
    R2ProxyService,
    PostgresImageService
  ]
})
export class KubernetesModule {}
