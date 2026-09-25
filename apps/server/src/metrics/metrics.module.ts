import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { VictoriaMetricsService } from './victoria-metrics.service';
import { MetricsController } from './metrics.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, OrganizationsModule],
  providers: [MetricsService, VictoriaMetricsService],
  controllers: [MetricsController],
  exports: [MetricsService, VictoriaMetricsService]
})
export class MetricsModule {}
