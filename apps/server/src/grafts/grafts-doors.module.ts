import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GraftDbPools } from './db-pools';
import { doorProviders, doorTokens } from './doors';
import { GraftHttpRegistry } from './http-registry';

@Global()
@Module({
  imports: [AuthModule],
  providers: [GraftDbPools, GraftHttpRegistry, ...doorProviders()],
  exports: [GraftDbPools, GraftHttpRegistry, ...doorTokens()]
})
export class GraftDoorsModule {}
