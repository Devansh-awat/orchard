import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability/observability.module';
import { LogsService } from './logs.service';
import { LogsController } from './logs.controller';

@Module({
  imports: [PrismaModule, ProjectsModule, ObservabilityModule],
  providers: [LogsService],
  controllers: [LogsController],
  exports: [LogsService]
})
export class LogsModule {}
