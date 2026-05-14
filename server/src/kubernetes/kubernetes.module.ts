import { Module } from '@nestjs/common';
import { KubernetesController } from './kubernetes.controller';
import { KubernetesService } from './kubernetes.service';
import { R2ProxyService } from './r2-proxy.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [KubernetesController],
  providers: [KubernetesService, R2ProxyService],
  exports: [KubernetesService, R2ProxyService],
})
export class KubernetesModule {}
