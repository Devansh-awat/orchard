import { RegistryCredentialsModule } from '../projects/registry-credentials.module';
import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DockerController } from './docker.controller';
import { DockerService } from './docker.service';
import { ImageBuilderService } from './image-builder.service';
import { BuildKitPoolService } from './buildkit-pool.service';
import { BuildJobInformerService } from './build-job-informer.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LeaderElectionService } from '../events/leader-election.service';
import { FirecrackerClient } from './fc/fc-client';
import { BuildBackendRouter } from './fc/build-backend-router';
import { BuildCacheService } from './build-cache.service';
import { RegistryPruneService } from './registry-prune.service';
import { BuildCacheController } from './build-cache.controller';
import { KubernetesModule } from '../kubernetes/kubernetes.module';

@Module({
  imports: [RegistryCredentialsModule, AuthModule, PrismaModule, KubernetesModule],
  controllers: [DockerController, BuildCacheController],
  providers: [
    DockerService,
    ImageBuilderService,
    BuildKitPoolService,
    BuildJobInformerService,
    FirecrackerClient,
    BuildBackendRouter,
    BuildCacheService,
    RegistryPruneService
  ],
  exports: [
    DockerService,
    ImageBuilderService,
    BuildKitPoolService,
    BuildJobInformerService,
    FirecrackerClient,
    BuildBackendRouter,
    BuildCacheService,
    RegistryPruneService
  ]
})
export class DockerModule implements OnModuleInit, OnModuleDestroy {
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly buildKitPool: BuildKitPoolService,
    private readonly leaderElection: LeaderElectionService
  ) {}

  onModuleInit() {
    // Reap idle daemon pods every 5 minutes
    this.reaperInterval = setInterval(() => {
      if (!this.leaderElection.isLeader()) return;
      this.buildKitPool
        .reapIdleDaemons()
        .catch((err) => console.error('[DockerModule] reaper error:', err.message));
    }, 5 * 60_000);
  }

  onModuleDestroy() {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }
}
