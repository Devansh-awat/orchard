import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { OrgEventsService } from './org-events.service';
import { EventBusService } from './event-bus.service';
import { LeaderElectionService } from './leader-election.service';
import { EventsController } from './events.controller';
import { PrismaEventsBridge } from './prisma-events.bridge';
import { K8sPodInformerService } from '../kubernetes/k8s-pod-informer.service';
import { K8sCnpgInformerService } from '../kubernetes/k8s-cnpg-informer.service';
import { PodLogCaptureService } from '../kubernetes/pod-log-capture.service';

@Global()
@Module({
  imports: [AuthModule, KubernetesModule],
  providers: [
    EventBusService,
    LeaderElectionService,
    OrgEventsService,
    PrismaEventsBridge,
    K8sPodInformerService,
    K8sCnpgInformerService,
    PodLogCaptureService,
  ],
  controllers: [EventsController],
  exports: [OrgEventsService, LeaderElectionService, PodLogCaptureService],
})
export class EventsModule {}
