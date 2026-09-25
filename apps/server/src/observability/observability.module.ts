import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { ErrorIngestService } from './error-ingest.service';
import { TimelineService } from './timeline.service';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [PrismaModule, KubernetesModule, ProjectsModule, EventsModule, MetricsModule],
  providers: [ObservabilityService, ErrorIngestService, TimelineService],
  controllers: [ObservabilityController],
  exports: [ObservabilityService, ErrorIngestService, TimelineService]
})
export class ObservabilityModule {}
