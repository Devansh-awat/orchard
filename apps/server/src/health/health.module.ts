import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GracefulShutdownService } from './graceful-shutdown.service';

@Module({
  controllers: [HealthController],
  providers: [GracefulShutdownService]
})
export class HealthModule {}
