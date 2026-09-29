import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GitHubModule } from '../github/github.module';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';

@Global()
@Module({
  imports: [PrismaModule, GitHubModule],
  controllers: [TelemetryController],
  providers: [TelemetryService],
  exports: [TelemetryService]
})
export class TelemetryModule {}
