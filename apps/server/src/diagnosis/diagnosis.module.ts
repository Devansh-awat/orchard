import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SecurityModule } from '../security/security.module';
import { AnomaliesModule } from '../anomalies/anomalies.module';
import { MetricsModule } from '../metrics/metrics.module';
import { DiagnosisService } from './diagnosis.service';
import { DiagnosisController } from './diagnosis.controller';

@Module({
  imports: [
    PrismaModule,
    ProjectsModule,
    ObservabilityModule,
    SecurityModule,
    AnomaliesModule,
    MetricsModule
  ],
  providers: [DiagnosisService],
  controllers: [DiagnosisController],
  exports: [DiagnosisService]
})
export class DiagnosisModule {}
