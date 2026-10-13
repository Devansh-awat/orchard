import { Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { LeaderElectionService } from '../core/leader-election.service';
import { InstanceSettingsService } from '../core/instance-settings.service';
import { SandboxesController } from './sandboxes.controller';
import { UserContextController } from './context/user-context.controller';
import { UserContextService } from './context/user-context.service';
import { SandboxSessionsController } from './sandbox-sessions.controller';
import { SandboxSessionsService } from './sandbox-sessions.service';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxGitActorService } from './sandbox-git-identity';
import { SandboxesService } from './sandboxes.service';
import { SandboxChatService } from './sandbox-chat.service';
import { SandboxWorkspaceService } from './sandbox-workspace.service';
import { SandboxConversationsService } from './sandbox-conversations.service';
import { SandboxReaperService } from './sandbox-reaper.service';
import { SandboxEnabledGuard } from './sandbox-enabled.guard';
import { SandboxConnectService } from './sandbox-connect.service';
import { SandboxMembersController } from './sandbox-members.controller';
import { SandboxMembersService } from './sandbox-members.service';
import { SandboxLiveService } from './live/sandbox-live.service';
import { SandboxPreviewService } from './preview/sandbox-preview.service';
import { SandboxAttentionService } from './sandbox-attention.service';
import { SandboxProjectEnvService } from './links/sandbox-project-env.service';
import { SandboxProjectLinksService } from './links/sandbox-project-links.service';
import { SandboxPreviewDeployService } from './links/sandbox-preview-deploy.service';
import { SandboxLinksController } from './links/sandbox-links.controller';
import { SandboxAgentService } from './sandbox-agent.service';
import { SandboxAgentUsageService } from './sandbox-agent-usage.service';
import { SandboxCoauthorsService } from './sandbox-coauthors.service';
import { SandboxAgentController } from './sandbox-agent.controller';
import { SandboxForkService } from './sandbox-fork.service';
import { SandboxForkController } from './sandbox-fork.controller';
import { SandboxShareLinksService } from './sandbox-share-links.service';
import {
  SandboxShareLinksController,
  SandboxShareViewerController
} from './sandbox-share-links.controller';
import { KubernetesSandboxRunner } from './runners/kubernetes.runner';
import { VercelSandboxRunner } from './runners/vercel.runner';
import { SandboxSecretsService } from './runners/sandbox-secrets';
import { SandboxProbesService } from './runners/sandbox-probes.service';
import { SANDBOX_RUNNER_PROVIDERS, SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxRunner } from './runners/sandbox-runner';
import { SandboxUsageService } from './sandbox-usage.service';
import { SandboxUsageController } from './sandbox-usage.controller';
import { SandboxMirrorConsumer } from './sandbox-mirror.consumer';
import { GreenhouseWiring } from './greenhouse-wiring.service';

const REAPER_INTERVAL_MS = 60_000;

@Module({
  imports: [CoreModule],
  controllers: [
    SandboxesController,
    SandboxSessionsController,
    SandboxMembersController,
    SandboxLinksController,
    SandboxAgentController,
    SandboxForkController,
    SandboxShareLinksController,
    SandboxShareViewerController,
    SandboxUsageController,
    UserContextController
  ],
  providers: [
    UserContextService,
    SandboxesService,
    SandboxSecretsService,
    KubernetesSandboxRunner,
    VercelSandboxRunner,
    {
      provide: SANDBOX_RUNNER_PROVIDERS,
      useFactory: (
        kubernetes: KubernetesSandboxRunner,
        vercel: VercelSandboxRunner
      ): SandboxRunner[] => [kubernetes, vercel],
      inject: [KubernetesSandboxRunner, VercelSandboxRunner]
    },
    SandboxRunnerRegistry,
    SandboxProbesService,
    SandboxChatService,
    SandboxWorkspaceService,
    SandboxConversationsService,
    SandboxSessionsService,
    SandboxAccessService,
    SandboxGitActorService,
    SandboxReaperService,
    SandboxEnabledGuard,
    SandboxConnectService,
    SandboxLiveService,
    SandboxMembersService,
    SandboxPreviewService,
    SandboxAttentionService,
    SandboxProjectEnvService,
    SandboxProjectLinksService,
    SandboxPreviewDeployService,
    SandboxAgentService,
    SandboxAgentUsageService,
    SandboxCoauthorsService,
    SandboxForkService,
    SandboxShareLinksService,
    SandboxUsageService,
    SandboxMirrorConsumer,
    GreenhouseWiring
  ],
  exports: [
    SandboxesService,
    SandboxWorkspaceService,
    SandboxRunnerRegistry,
    KubernetesSandboxRunner,
    SandboxSessionsService,
    SandboxAccessService,
    SandboxGitActorService,
    SandboxLiveService,
    SandboxMembersService,
    SandboxPreviewService,
    SandboxAgentService
  ]
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
