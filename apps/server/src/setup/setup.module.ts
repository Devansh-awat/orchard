import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';
import { GitHubModule } from '../github/github.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { SetupService } from './setup.service';
import { SetupController } from './setup.controller';

@Module({
  imports: [PrismaModule, AuthModule, AdminModule, GitHubModule, KubernetesModule],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService]
})
export class SetupModule {}
