import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { SshIdentitiesController } from './ssh-identities.controller';
import { SshIdentitiesService } from './ssh-identities.service';

@Module({
  imports: [CoreModule],
  controllers: [SshIdentitiesController],
  providers: [SshIdentitiesService],
  exports: [SshIdentitiesService]
})
export class SshIdentitiesModule {}
