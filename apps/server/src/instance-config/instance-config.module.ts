import { Global, Module } from '@nestjs/common';
import { InstanceConfigService } from './instance-config.service';
import { InstanceConfigController } from './instance-config.controller';
import { InstanceLimitsController } from './instance-limits.controller';

@Global()
@Module({
  controllers: [InstanceConfigController, InstanceLimitsController],
  providers: [InstanceConfigService],
  exports: [InstanceConfigService]
})
export class InstanceConfigModule {}
