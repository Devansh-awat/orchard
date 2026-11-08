import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';
import { SelfTestClusterFactory } from './selftest.cluster';
import { SelfTestService } from './selftest.service';

@Module({
  imports: [AuthModule, KubernetesModule],
  controllers: [DoctorController],
  providers: [DoctorService, SelfTestService, SelfTestClusterFactory]
})
export class DoctorModule {}
