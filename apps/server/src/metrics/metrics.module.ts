import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { VictoriaMetricsService } from './victoria-metrics.service';
import { SignalPresenceService } from './signal-presence.service';
import { MetricsController } from './metrics.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, OrganizationsModule],
  providers: [MetricsService, VictoriaMetricsService, SignalPresenceService],
  controllers: [MetricsController],
  exports: [MetricsService, VictoriaMetricsService, SignalPresenceService]
})
export class MetricsModule {}
