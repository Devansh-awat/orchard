import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { OrgEventsService } from './org-events.service';
import { EventsController } from './events.controller';
import { PrismaEventsBridge } from './prisma-events.bridge';

@Global()
@Module({
  imports: [AuthModule, KubernetesModule],
  providers: [OrgEventsService, PrismaEventsBridge],
  controllers: [EventsController],
  exports: [OrgEventsService],
})
export class EventsModule {}
