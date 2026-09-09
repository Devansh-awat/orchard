import { Global, Module } from '@nestjs/common';
import { InstanceConfigService } from './instance-config.service';
import { InstanceConfigController } from './instance-config.controller';

@Global()
@Module({
  controllers: [InstanceConfigController],
  providers: [InstanceConfigService],
  exports: [InstanceConfigService],
})
export class InstanceConfigModule {}
