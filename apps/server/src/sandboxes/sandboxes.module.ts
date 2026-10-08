import { Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LeaderElectionService } from '../events/leader-election.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { SandboxChatService } from './sandbox-chat.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxConversationsService } from './sandbox-conversations.service';
import { SandboxReaperService } from './sandbox-reaper.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { KubernetesSandboxRunner } from './runners/kubernetes.runner';
import { SandboxSecretsService } from './runners/sandbox-secrets';
import { SandboxProbesService } from './runners/sandbox-probes.service';
import { SANDBOX_RUNNER_PROVIDERS, SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxRunner } from './runners/sandbox-runner';

const REAPER_INTERVAL_MS = 60_000;

@Module({
  imports: [AuthModule, PrismaModule, KubernetesModule, UsersModule, AuditModule, AnalyticsModule],
  controllers: [SandboxesController],
  providers: [
    SandboxesService,
    SandboxSecretsService,
    KubernetesSandboxRunner,
    {
      provide: SANDBOX_RUNNER_PROVIDERS,
      useFactory: (kubernetes: KubernetesSandboxRunner): SandboxRunner[] => [kubernetes],
      inject: [KubernetesSandboxRunner]
    },
    SandboxRunnerRegistry,
    SandboxProbesService,
    SandboxChatService,
    SandboxWorkspaceService,
    SandboxConversationsService,
    SandboxReaperService,
    SandboxEnabledGuard
  ],
  exports: [SandboxesService, SandboxRunnerRegistry, KubernetesSandboxRunner]
})
export class SandboxesModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxesModule.name);

  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reaper: SandboxReaperService,
    private readonly leaderElection: LeaderElectionService,
    private readonly settings: InstanceSettingsService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly kubernetesRunner: KubernetesSandboxRunner
  ) {}

  onModuleInit() {
    this.reaperInterval = setInterval(() => {
      if (!this.leaderElection.isLeader()) return;
      void this.tick();
    }, REAPER_INTERVAL_MS);
    this.reaperInterval.unref?.();
    this.leaderElection.onAcquired(() => {
      void this.ensureInfrastructure();
    });
  }

  onModuleDestroy() {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }

  private async tick(): Promise<void> {
    if (!(await this.settings.isSandboxesEnabled().catch(() => false))) return;
    await this.reaper.tick();
  }

  private async ensureInfrastructure(): Promise<void> {
    try {
      if (!(await this.settings.isSandboxesEnabled())) return;
      if (!this.registry.enabled('kubernetes')) return;
      if (this.kubernetesRunner.configError()) return;
      await this.kubernetesRunner.enqueueInfrastructure();
    } catch (e: any) {
      this.logger.warn(`could not enqueue sandbox infrastructure: ${e?.message}`);
    }
  }
}
