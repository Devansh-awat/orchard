import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { ErrorIngestService } from './error-ingest.service';
import { ErrorRetentionService } from './error-retention.service';
import { TimelineService } from './timeline.service';
import { VerdictsService } from './verdicts.service';
import { FindingsService } from './findings.service';
import { VictoriaLogsService } from '../logs/victoria-logs.service';
import { RequestsService } from '../logs/requests.service';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [PrismaModule, KubernetesModule, ProjectsModule, EventsModule, MetricsModule],
  providers: [
    ObservabilityService,
    ErrorIngestService,
    ErrorRetentionService,
    TimelineService,
    VerdictsService,
    FindingsService,
    VictoriaLogsService,
    RequestsService
  ],
  controllers: [ObservabilityController],
  exports: [
    ObservabilityService,
    ErrorIngestService,
    TimelineService,
    VerdictsService,
    FindingsService,
    VictoriaLogsService,
    RequestsService
  ]
})
export class ObservabilityModule {}
