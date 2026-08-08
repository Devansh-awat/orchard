import { Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { JobsModule } from '../jobs/jobs.module';
import { MirrorService } from './mirror.service';
import { MirrorHealthController } from './mirror-health.controller';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';

@Module({
  imports: [KubernetesModule, JobsModule],
  providers: [MirrorService, PodMirrorConsumer, CnpgMirrorConsumer, WorkloadMirrorConsumer],
  controllers: [MirrorHealthController],
})
export class MirrorModule {}
