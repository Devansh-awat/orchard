import { Module, forwardRef } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { GitHubModule } from '../github/github.module';
import { DockerModule } from '../docker/docker.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NodesModule } from '../nodes/nodes.module';
import { QuotasModule } from '../quotas/quotas.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ProjectsService } from './projects.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { EnvironmentSharedVarsService } from './environment-shared-vars.service';
import { DatabasesService } from './databases.service';
import { BackupSyncService } from './backup-sync.service';
import { ImportSettleService } from './import-settle.service';
import { DeploymentsService } from './deployments.service';
import { ReleasesService } from './releases.service';
import { ResourceBindingsService } from './resource-bindings.service';
import { ResourceBindingsController } from './resource-bindings.controller';
import { BlueGreenSettleService } from './blue-green-settle.service';
import { ProjectOrgTransferService } from './project-org-transfer.service';
import { BuildQueueService } from './build-queue.service';
import { IngressService } from './ingress.service';
import { FaviconService } from './favicon.service';
import {
  ProjectsController,
  DeploymentsController,
  IngressesController,
  DatabasesController
} from './projects.controller';
import { EnvironmentsController } from './environments.controller';
import { OverviewController } from './overview.controller';
import { ProjectTransfersController } from './project-transfers.controller';

@Module({
  imports: [
    KubernetesModule,
    UsersModule,
    forwardRef(() => GitHubModule),
    DockerModule,
    WebhooksModule,
    OrganizationsModule,
    forwardRef(() => NodesModule),
    forwardRef(() => QuotasModule),
    TailscaleModule,
    AuthModule,
    EventsModule,
    MetricsModule
  ],
  providers: [
    ProjectsService,
    ProjectAccessService,
    EnvironmentsService,
    EnvironmentSharedVarsService,
    DatabasesService,
    BackupSyncService,
    ImportSettleService,
    DeploymentsService,
    ResourceBindingsService,
    ReleasesService,
    BlueGreenSettleService,
    ProjectOrgTransferService,
    BuildQueueService,
    IngressService,
    FaviconService
  ],
  controllers: [
    ProjectsController,
    DeploymentsController,
    ResourceBindingsController,
    IngressesController,
    DatabasesController,
    EnvironmentsController,
    OverviewController,
    ProjectTransfersController
  ],
  exports: [
    ProjectsService,
    ProjectAccessService,
    EnvironmentsService,
    EnvironmentSharedVarsService,
    DatabasesService,
    DeploymentsService,
    IngressService
  ]
})
export class ProjectsModule {}
