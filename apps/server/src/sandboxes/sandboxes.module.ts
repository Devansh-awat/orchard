import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LeaderElectionService } from '../events/leader-election.service';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { SandboxChatService } from './sandbox-chat.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxK8sService } from './sandbox-k8s.service';
import { SandboxReaperService } from './sandbox-reaper.service';
import { SandboxEnabledGuard, sandboxFeatureEnabled } from './sandbox-enabled.guard';

const REAPER_INTERVAL_MS = 60_000;

@Module({
  imports: [AuthModule, PrismaModule, KubernetesModule, UsersModule, AuditModule, AnalyticsModule],
  controllers: [SandboxesController],
  providers: [SandboxesService, SandboxK8sService, SandboxChatService, SandboxWorkspaceService, SandboxReaperService, SandboxEnabledGuard],
  exports: [SandboxesService, SandboxK8sService],
})
export class SandboxesModule implements OnModuleInit, OnModuleDestroy {
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reaper: SandboxReaperService,
    private readonly leaderElection: LeaderElectionService,
  ) {}

  onModuleInit() {
    if (!sandboxFeatureEnabled()) return;
    this.reaperInterval = setInterval(() => {
      if (!this.leaderElection.isLeader()) return;
      void this.reaper.tick();
    }, REAPER_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }
}
