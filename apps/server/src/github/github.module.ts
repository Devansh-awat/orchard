import { Module, forwardRef } from '@nestjs/common';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubAppSetupService } from './github-app-setup.service';
import { GithubAppSetupController } from './github-app-setup.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [PrismaModule, UsersModule, AuthModule, forwardRef(() => ProjectsModule)],
  controllers: [GitHubController, GithubAppSetupController],
  providers: [GitHubService, GithubAppConfigService, GithubAppSetupService],
  exports: [GitHubService, GithubAppConfigService],
})
export class GitHubModule {}

