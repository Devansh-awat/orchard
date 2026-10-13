import { Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { JobsModule } from '../jobs/jobs.module';
import { MirrorService } from './mirror.service';
import { MirrorHealthController } from './mirror-health.controller';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';
import { IngressMirrorConsumer } from './consumers/ingress-mirror.consumer';
import { StorageMirrorConsumer } from './consumers/storage-mirror.consumer';
import { ServiceMirrorConsumer } from './consumers/service-mirror.consumer';
import { NamespaceMirrorConsumer } from './consumers/namespace-mirror.consumer';

@Module({
  imports: [KubernetesModule, JobsModule],
  providers: [
    MirrorService,
    PodMirrorConsumer,
    CnpgMirrorConsumer,
    WorkloadMirrorConsumer,
    IngressMirrorConsumer,
    StorageMirrorConsumer,
    ServiceMirrorConsumer,
    NamespaceMirrorConsumer
  ],
  controllers: [MirrorHealthController]
})
export class MirrorModule {}
