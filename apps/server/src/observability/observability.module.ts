import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { ErrorIngestService } from './error-ingest.service';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [PrismaModule, KubernetesModule, ProjectsModule, EventsModule],
  providers: [ObservabilityService, ErrorIngestService],
  controllers: [ObservabilityController],
  exports: [ObservabilityService, ErrorIngestService],
})
export class ObservabilityModule {}
