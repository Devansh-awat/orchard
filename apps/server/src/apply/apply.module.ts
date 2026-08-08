import { Global, Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ApplyQueueService } from './apply-queue.service';
import { ApplyExecutorService } from './apply-executor.service';

@Global()
@Module({
  imports: [KubernetesModule],
  providers: [ApplyQueueService, ApplyExecutorService],
  exports: [ApplyQueueService, ApplyExecutorService],
})
export class ApplyModule {}
