import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { OrgEventsService } from './org-events.service';
import { EventBusService } from './event-bus.service';
import { EventsController } from './events.controller';
import { PrismaEventsBridge } from './prisma-events.bridge';
import { K8sPodInformerService } from '../kubernetes/k8s-pod-informer.service';

@Global()
@Module({
  imports: [AuthModule, KubernetesModule],
  providers: [EventBusService, OrgEventsService, PrismaEventsBridge, K8sPodInformerService],
  controllers: [EventsController],
  exports: [OrgEventsService],
})
export class EventsModule {}
