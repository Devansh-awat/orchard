import { Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { JobsModule } from '../jobs/jobs.module';
import { SandboxesModule } from '../sandboxes/sandboxes.module';
import { MirrorService } from './mirror.service';
import { MirrorHealthController } from './mirror-health.controller';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';
import { SandboxMirrorConsumer } from './consumers/sandbox-mirror.consumer';

@Module({
  imports: [KubernetesModule, JobsModule, SandboxesModule],
  providers: [
    MirrorService,
    PodMirrorConsumer,
    CnpgMirrorConsumer,
    WorkloadMirrorConsumer,
    SandboxMirrorConsumer
  ],
  controllers: [MirrorHealthController]
})
export class MirrorModule {}
