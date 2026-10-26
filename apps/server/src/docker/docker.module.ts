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

@Module({
  imports: [RegistryCredentialsModule, AuthModule, PrismaModule],
  controllers: [DockerController],
  providers: [
    DockerService,
    ImageBuilderService,
    BuildKitPoolService,
    BuildJobInformerService,
    FirecrackerClient,
    BuildBackendRouter
  ],
  exports: [
    DockerService,
    ImageBuilderService,
    BuildKitPoolService,
    BuildJobInformerService,
    FirecrackerClient,
    BuildBackendRouter
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
