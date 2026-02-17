import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { KubernetesModule } from './kubernetes/kubernetes.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProjectsModule } from './projects/projects.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.module';
import { GitHubModule } from './github/github.module';
import { DockerModule } from './docker/docker.module';
import { EmailModule } from './email/email.module';
import { AdminModule } from './admin/admin.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    HealthModule,
    KubernetesModule,
    WorkspacesModule,
    ProjectsModule,
    OrganizationsModule,
    GitHubModule,
    DockerModule,
    EmailModule,
    AdminModule,
    WebhooksModule,
  ],
})
export class AppModule {}

