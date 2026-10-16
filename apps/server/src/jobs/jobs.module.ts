import { Module } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { NodesModule } from '../nodes/nodes.module';
import { UsersModule } from '../users/users.module';
import { ProjectsModule } from '../projects/projects.module';
import { QuotasModule } from '../quotas/quotas.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { JobsService } from './jobs.service';
import { JobsOrchestratorService } from './jobs-orchestrator.service';
import { K8sJobInformerService } from './k8s-job-informer.service';
import { JobsSyncService } from './jobs-sync.service';
import { JobsController } from './jobs.controller';
import { JobConsumer } from '../engine/consumers/job.consumer';
import { engineDisabled } from '../engine/engine-disabled';

const legacyInformers = engineDisabled() ? [K8sJobInformerService] : [];

@Module({
  imports: [
    KubernetesModule,
    NodesModule,
    UsersModule,
    ProjectsModule,
    QuotasModule,
    NotificationsModule,
    EventsModule,
    AuditModule
  ],
  providers: [
    JobsService,
    JobsOrchestratorService,
    JobConsumer,
    JobsSyncService,
    ...legacyInformers
  ],
  controllers: [JobsController],
  exports: [JobsService, JobsOrchestratorService, JobConsumer]
})
export class JobsModule {}
