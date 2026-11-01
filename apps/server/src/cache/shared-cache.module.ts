import { Global, Module } from '@nestjs/common';
import { SharedCache } from './shared-cache.service';

@Global()
@Module({
  providers: [SharedCache],
  exports: [SharedCache]
})
export class SharedCacheModule {}
