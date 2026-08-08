import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InstanceSettingsService } from './instance-settings.service';
import { InstanceSettingsController } from './instance-settings.controller';

// Global so the resolver (InstanceSettingsService) is injectable anywhere —
// the userspace-scheduling guard and NodesService both read it — without every
// module importing this one.
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [InstanceSettingsController],
  providers: [InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
