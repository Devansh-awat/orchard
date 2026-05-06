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
import { ProjectsService } from './projects.service';
import { FaviconService } from './favicon.service';
import { ProjectsController, DeploymentsController, IngressesController, DatabasesController } from './projects.controller';
import { OverviewController } from './overview.controller';

@Module({
  imports: [KubernetesModule, UsersModule, forwardRef(() => GitHubModule), DockerModule, WebhooksModule, OrganizationsModule, forwardRef(() => NodesModule), forwardRef(() => QuotasModule), TailscaleModule, AuthModule, EventsModule],
  providers: [ProjectsService, FaviconService],
  controllers: [ProjectsController, DeploymentsController, IngressesController, DatabasesController, OverviewController],
  exports: [ProjectsService],
})
export class ProjectsModule {}

