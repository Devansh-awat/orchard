import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { GitHubModule } from '../github/github.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { ComposeStacksService } from './compose-stacks.service';
import { ComposeStacksController } from './compose-stacks.controller';

@Module({
  imports: [ProjectsModule, AuthModule, UsersModule, GitHubModule, KubernetesModule],
  providers: [ComposeStacksService],
  controllers: [ComposeStacksController],
  exports: [ComposeStacksService]
})
export class ComposeStacksModule {}
