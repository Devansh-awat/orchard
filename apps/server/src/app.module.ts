import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ApiThrottlerGuard, apiThrottlerLimit } from './auth/api-throttler.guard';
import { HealthModule } from './health/health.module';
import { KubernetesModule } from './kubernetes/kubernetes.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { ProjectsModule } from './projects/projects.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.module';
import { GitHubModule } from './github/github.module';
import { DockerModule } from './docker/docker.module';
import { EmailModule } from './email/email.module';
import { AdminModule } from './admin/admin.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TemplatesModule } from './templates/templates.module';
import { ComposeStacksModule } from './compose-stacks/compose-stacks.module';
import { SsoModule } from './sso/sso.module';
import { ScimModule } from './scim/scim.module';
import { NodesModule } from './nodes/nodes.module';
import { InstanceSettingsModule } from './instance-settings/instance-settings.module';
import { QuotasModule } from './quotas/quotas.module';
import { TailscaleModule } from './tailscale/tailscale.module';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { ObservabilityModule } from './observability/observability.module';
import { NotificationsModule } from './notifications/notifications.module';
import { JobsModule } from './jobs/jobs.module';
import { ForumModule } from './forum/forum.module';
import { SandboxesModule } from './sandboxes/sandboxes.module';
import { SshIdentitiesModule } from './ssh-identities/ssh-identities.module';
import { CoordinationModule } from './coordination/coordination.module';
import { MirrorModule } from './mirror/mirror.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Rate limiting across the whole API: 200 req/60s per IP, or 600 req/60s
    // per token for PAT bearers (ApiThrottlerGuard keys those buckets on a
    // sha256 of the token). Tune per-route with @Throttle({...}) or exempt
    // with @SkipThrottle().
    ThrottlerModule.forRoot([{ ttl: 60000, limit: apiThrottlerLimit }]),
    PrismaModule,
    CryptoModule,
    AuthModule,
    UsersModule,
    HealthModule,
    KubernetesModule,
    CoordinationModule,
    ProjectsModule,
    OrganizationsModule,
    GitHubModule,
    DockerModule,
    EmailModule,
    AdminModule,
    InstanceSettingsModule,
    WebhooksModule,
    TemplatesModule,
    ComposeStacksModule,
    SsoModule,
    ScimModule,
    NodesModule,
    QuotasModule,
    TailscaleModule,
    EventsModule,
    MetricsModule,
    AuditModule,
    AnalyticsModule,
    AiChatModule,
    ObservabilityModule,
    NotificationsModule,
    JobsModule,
    ForumModule,
    SandboxesModule,
    SshIdentitiesModule,
    MirrorModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }],
})
export class AppModule {}

