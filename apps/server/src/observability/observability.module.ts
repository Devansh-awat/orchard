import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { ErrorIngestService } from './error-ingest.service';
import { TimelineService } from './timeline.service';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [PrismaModule, KubernetesModule, ProjectsModule, EventsModule],
  providers: [ObservabilityService, ErrorIngestService, TimelineService],
  controllers: [ObservabilityController],
  exports: [ObservabilityService, ErrorIngestService, TimelineService]
})
export class ObservabilityModule {}
