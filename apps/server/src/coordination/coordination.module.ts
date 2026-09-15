import { Global, Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { LeaseService } from './lease.service';

@Global()
@Module({
  imports: [KubernetesModule],
  providers: [LeaseService],
  exports: [LeaseService]
})
export class CoordinationModule {}
