import { Module, forwardRef } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { GitHubModule } from '../github/github.module';
import { DockerModule } from '../docker/docker.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ProjectsService } from './projects.service';
import { ProjectsController, DeploymentsController } from './projects.controller';

@Module({
  imports: [KubernetesModule, UsersModule, forwardRef(() => GitHubModule), DockerModule, WebhooksModule],
  providers: [ProjectsService],
  controllers: [ProjectsController, DeploymentsController],
  exports: [ProjectsService],
})
export class ProjectsModule {}

