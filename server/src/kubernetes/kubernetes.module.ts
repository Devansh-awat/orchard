import { Module } from '@nestjs/common';
import { KubernetesController } from './kubernetes.controller';
import { KubernetesService } from './kubernetes.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [KubernetesController],
  providers: [KubernetesService],
  exports: [KubernetesService],
})
export class KubernetesModule {}

