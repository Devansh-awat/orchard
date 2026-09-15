import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { NodesModule } from '../nodes/nodes.module';
import { OrgEventsService } from './org-events.service';
import { EventBusService } from './event-bus.service';
import { LeaderElectionService } from './leader-election.service';
import { EventsController } from './events.controller';
import { PrismaEventsBridge } from './prisma-events.bridge';
import { MetricsPusherService } from './metrics-pusher.service';
import { K8sPodInformerService } from '../kubernetes/k8s-pod-informer.service';
import { K8sCnpgInformerService } from '../kubernetes/k8s-cnpg-informer.service';
import { K8sNodeInformerService } from '../kubernetes/k8s-node-informer.service';
import { PodLogCaptureService } from '../kubernetes/pod-log-capture.service';

const legacyInformers =
  process.env.MIRROR_DISABLED === 'true' ? [K8sPodInformerService, K8sCnpgInformerService] : [];

@Global()
@Module({
  imports: [AuthModule, KubernetesModule, NodesModule],
  providers: [
    EventBusService,
    LeaderElectionService,
    OrgEventsService,
    PrismaEventsBridge,
    K8sNodeInformerService,
    PodLogCaptureService,
    MetricsPusherService,
    ...legacyInformers
  ],
  controllers: [EventsController],
  exports: [OrgEventsService, LeaderElectionService, PodLogCaptureService]
})
export class EventsModule {}
