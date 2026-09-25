import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ProjectsModule } from '../projects/projects.module';
import { MetricAlertsService } from './metric-alerts.service';
import { AlertsController } from './alerts.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    MetricsModule,
    ObservabilityModule,
    ProjectsModule
  ],
  providers: [MetricAlertsService],
  controllers: [AlertsController],
  exports: [MetricAlertsService]
})
export class AlertsModule {}
