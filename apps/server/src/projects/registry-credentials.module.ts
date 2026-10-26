import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { RegistryCredentialsService } from './registry-credentials.service';

@Module({
  imports: [PrismaModule, KubernetesModule],
  providers: [RegistryCredentialsService],
  exports: [RegistryCredentialsService]
})
export class RegistryCredentialsModule {}
