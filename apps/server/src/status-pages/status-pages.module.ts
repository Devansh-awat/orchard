import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { StatusPagesService } from './status-pages.service';
import { PublicStatusController, StatusPagesController } from './status-pages.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule, KubernetesModule],
  controllers: [PublicStatusController, StatusPagesController],
  providers: [StatusPagesService],
  exports: [StatusPagesService]
})
export class StatusPagesModule {}
