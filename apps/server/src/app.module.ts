import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module';
import { KubernetesModule } from './kubernetes/kubernetes.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
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
import { QuotasModule } from './quotas/quotas.module';
import { TailscaleModule } from './tailscale/tailscale.module';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { ObservabilityModule } from './observability/observability.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Per-IP rate limiting across the whole API (200 req/60s). Tune per-route
    // with @Throttle({...}) or exempt with @SkipThrottle().
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 200 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    HealthModule,
    KubernetesModule,
    ProjectsModule,
    OrganizationsModule,
    GitHubModule,
    DockerModule,
    EmailModule,
    AdminModule,
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
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

