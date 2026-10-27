import { Global, Module } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENCY_STORE, RedisIdempotencyStore } from './idempotency.store';

@Global()
@Module({
  providers: [
    RedisIdempotencyStore,
    { provide: IDEMPOTENCY_STORE, useExisting: RedisIdempotencyStore },
    IdempotencyInterceptor
  ],
  exports: [IDEMPOTENCY_STORE, IdempotencyInterceptor]
})
export class IdempotencyModule {}
