import { Module } from '@nestjs/common';
import { KubernetesController } from './kubernetes.controller';
import { KubernetesService } from './kubernetes.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [KubernetesController],
  providers: [KubernetesService],
  exports: [KubernetesService],
})
export class KubernetesModule {}

