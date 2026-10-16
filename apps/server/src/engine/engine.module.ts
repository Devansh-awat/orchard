import { Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { JobsModule } from '../jobs/jobs.module';
import { EngineService } from './engine.service';
import { EngineHealthController } from './engine-health.controller';
import { PodConsumer } from './consumers/pod.consumer';
import { CnpgConsumer } from './consumers/cnpg.consumer';
import { WorkloadConsumer } from './consumers/workload.consumer';
import { IngressConsumer } from './consumers/ingress.consumer';
import { StorageConsumer } from './consumers/storage.consumer';
import { ServiceConsumer } from './consumers/service.consumer';
import { NamespaceConsumer } from './consumers/namespace.consumer';

@Module({
  imports: [KubernetesModule, JobsModule],
  providers: [
    EngineService,
    PodConsumer,
    CnpgConsumer,
    WorkloadConsumer,
    IngressConsumer,
    StorageConsumer,
    ServiceConsumer,
    NamespaceConsumer
  ],
  controllers: [EngineHealthController]
})
export class EngineModule {}
