import { Module, forwardRef } from '@nestjs/common';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [PrismaModule, UsersModule, AuthModule, forwardRef(() => ProjectsModule)],
  controllers: [GitHubController],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}

