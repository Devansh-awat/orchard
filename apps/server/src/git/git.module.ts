import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { CryptoModule } from '../crypto/crypto.module';
import { GitHubModule } from '../github/github.module';
import { ProjectsModule } from '../projects/projects.module';
import { GitConnectionsService } from './git-connections.service';
import { GitConnectionsController } from './git-connections.controller';
import { GitWebhookController } from './git-webhook.controller';
import { GitOauthService } from './git-oauth.service';
import { GitOauthController } from './git-oauth.controller';
import { RepoFilesService } from './repo-files.service';
import { InstanceConfigModule } from '../instance-config/instance-config.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    CryptoModule,
    InstanceConfigModule,
    forwardRef(() => GitHubModule),
    forwardRef(() => ProjectsModule)
  ],
  controllers: [GitConnectionsController, GitWebhookController, GitOauthController],
  providers: [GitConnectionsService, GitOauthService, RepoFilesService],
  exports: [GitConnectionsService, RepoFilesService]
})
export class GitModule {}
