import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, Response } from 'express';
import {
  Doors,
  type AuthDoor,
  type ExecDoor,
  type HttpDoor,
  type KubeDoor,
  type MirrorShard
} from '@orchardlabs/graft-sdk/server';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../core/analytics.service';
import { AuditService } from '../core/audit.service';
import { InstanceSettingsService } from '../core/instance-settings.service';
import { SessionsService } from '../core/sessions.service';
import { SandboxLiveService } from './live/sandbox-live.service';
import { attachSandboxLiveWebSocket } from './live/sandbox-live.gateway';
import { SandboxPreviewService } from './preview/sandbox-preview.service';
import { KubernetesSandboxRunner } from './runners/kubernetes.runner';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxAccessService } from './sandbox-access.service';
import { SandboxGitActorService } from './sandbox-git-identity';
import { SANDBOX_MCP_DEVICE } from './sandbox-mcp-scope';
import { SandboxMirrorConsumer } from './sandbox-mirror.consumer';
import { sandboxMirrorShard, type SandboxMirrorScope } from './sandbox-mirror.shard';
import { attachSandboxSshWebSocket } from './sandbox-ssh.gateway';
import { sandboxTerminalHooks } from './sandbox-terminal.gateway';

export const SANDBOX_MCP_DENY_PATHS = ['sandboxes/credentials', 'ssh-identities'];

@Injectable()
export class GreenhouseWiring implements OnModuleInit {
  private readonly logger = new Logger('Greenhouse');

  constructor(
    @Inject(Doors.auth) private readonly auth: AuthDoor,
    @Inject(Doors.http) private readonly http: HttpDoor,
    @Inject(Doors.exec) private readonly exec: ExecDoor,
    @Inject(Doors.kube) private readonly kube: KubeDoor,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(InstanceSettingsService) private readonly settings: InstanceSettingsService,
    @Inject(SandboxRunnerRegistry) private readonly registry: SandboxRunnerRegistry,
    @Inject(SandboxAccessService) private readonly accessService: SandboxAccessService,
    @Inject(SandboxGitActorService) private readonly gitActors: SandboxGitActorService,
    @Inject(SandboxLiveService) private readonly live: SandboxLiveService,
    @Inject(SandboxPreviewService) private readonly previews: SandboxPreviewService,
    @Inject(KubernetesSandboxRunner) private readonly kubernetesRunner: KubernetesSandboxRunner,
    @Inject(SandboxMirrorConsumer) private readonly mirror: SandboxMirrorConsumer
  ) {}

  onModuleInit(): void {
    this.auth.registerOrgScopedDevice(SANDBOX_MCP_DEVICE, SANDBOX_MCP_DENY_PATHS);
    this.http.hostRouter({
      matches: (host) => this.previews.isPreviewHost(host),
      handleRequest: (req: IncomingMessage, res: ServerResponse) =>
        this.previews.handleRequest(req as Request, res as Response),
      handleUpgrade: (req, socket, head) => this.previews.handleUpgrade(req, socket, head)
    });
    this.exec.register(
      sandboxTerminalHooks({
        prisma: this.prisma,
        sessions: this.sessions,
        audit: this.audit,
        analytics: this.analytics,
        settings: this.settings,
        registry: this.registry,
        accessService: this.accessService,
        gitActors: this.gitActors
      }) as unknown as Parameters<ExecDoor['register']>[0]
    );
    this.http.onListen((server) => {
      attachSandboxSshWebSocket(
        server,
        {
          auth: this.auth,
          prisma: this.prisma,
          sessions: this.sessions,
          audit: this.audit,
          registry: this.registry,
          settings: this.settings,
          analytics: this.analytics,
          accessService: this.accessService
        },
        (req) => this.previews.isPreviewHost(req.headers.host)
      );
      attachSandboxLiveWebSocket(server, {
        auth: this.auth,
        prisma: this.prisma,
        analytics: this.analytics,
        settings: this.settings,
        live: this.live,
        previews: this.previews
      });
    });
    this.kube.registerMirrorShard(() => this.mirrorShard());
  }

  private async mirrorShard(): Promise<MirrorShard | null> {
    const scope = await this.mirrorScope();
    return scope ? sandboxMirrorShard(scope, this.mirror) : null;
  }

  private async mirrorScope(): Promise<SandboxMirrorScope | null> {
    try {
      if (!(await this.settings.isSandboxesEnabled())) return null;
      if (!this.registry.enabled('kubernetes')) {
        const existing = await this.prisma.sandbox.count({ where: { runner: 'kubernetes' } });
        if (existing === 0) return null;
      }
      return {
        namespace: this.kubernetesRunner.namespace,
        instanceId: await this.kubernetesRunner.instanceId()
      };
    } catch (e: any) {
      this.logger.warn(`sandbox mirror shard disabled: ${e?.message}`);
      return null;
    }
  }
}
