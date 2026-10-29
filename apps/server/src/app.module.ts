import { Module, type DynamicModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ApiThrottlerGuard, apiThrottlerLimit } from './auth/api-throttler.guard';
import { HealthModule } from './health/health.module';
import { AgentSpecModule } from './agent-spec/agent-spec.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
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
import { InstanceConfigModule } from './instance-config/instance-config.module';
import { InstanceNetworkModule } from './instance-network/instance-network.module';
import { SetupModule } from './setup/setup.module';
import { QuotasModule } from './quotas/quotas.module';
import { TailscaleModule } from './tailscale/tailscale.module';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { ObservabilityModule } from './observability/observability.module';
import { LogsModule } from './logs/logs.module';
import { DiagnosisModule } from './diagnosis/diagnosis.module';
import { AlertsModule } from './alerts/alerts.module';
import { StatusPagesModule } from './status-pages/status-pages.module';
import { AnomaliesModule } from './anomalies/anomalies.module';
import { SecurityModule } from './security/security.module';
import { GitModule } from './git/git.module';
import { ScoreModule } from './score/score.module';
import { NotificationsModule } from './notifications/notifications.module';
import { JobsModule } from './jobs/jobs.module';
import { CoordinationModule } from './coordination/coordination.module';
import { EngineModule } from './engine/engine.module';
import { ApplyModule } from './apply/apply.module';
import { GraftsModule } from './grafts/grafts.module';
import { GraftDoorsModule } from './grafts/grafts-doors.module';
import type { GraftRecord } from './grafts/graft-registry';
import { graftImports } from './grafts/boot';

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
    AgentSpecModule,
    IdempotencyModule,
    KubernetesModule,
    CoordinationModule,
    ApplyModule,
    ProjectsModule,
    OrganizationsModule,
    GitHubModule,
    DockerModule,
    EmailModule,
    AdminModule,
    InstanceSettingsModule,
    InstanceConfigModule,
    InstanceNetworkModule,
    SetupModule,
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
    TelemetryModule,
    AiChatModule,
    ObservabilityModule,
    LogsModule,
    DiagnosisModule,
    AlertsModule,
    StatusPagesModule,
    AnomaliesModule,
    SecurityModule,
    GitModule,
    ScoreModule,
    NotificationsModule,
    JobsModule,
    EngineModule,
    GraftsModule,
    GraftDoorsModule
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }]
})
export class AppModule {
  static withGrafts(grafts: GraftRecord[]): DynamicModule {
    return { module: AppModule, imports: graftImports(grafts) };
  }
}
