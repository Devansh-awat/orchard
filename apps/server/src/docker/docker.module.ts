import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DockerController } from './docker.controller';
import { DockerService } from './docker.service';
import { ImageBuilderService } from './image-builder.service';
import { BuildKitPoolService } from './buildkit-pool.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LeaderElectionService } from '../events/leader-election.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [DockerController],
  providers: [DockerService, ImageBuilderService, BuildKitPoolService],
  exports: [DockerService, ImageBuilderService, BuildKitPoolService],
})
export class DockerModule implements OnModuleInit, OnModuleDestroy {
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly buildKitPool: BuildKitPoolService,
    private readonly leaderElection: LeaderElectionService,
  ) {}

  onModuleInit() {
    // Reap idle daemon pods every 5 minutes
    this.reaperInterval = setInterval(() => {
      if (!this.leaderElection.isLeader()) return;
      this.buildKitPool.reapIdleDaemons().catch(err =>
        console.error('[DockerModule] reaper error:', err.message),
      );
    }, 5 * 60_000);
  }

  onModuleDestroy() {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }
}

