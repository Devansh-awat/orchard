import { Module } from '@nestjs/common';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, KubernetesModule, UsersModule, AuthModule],
  controllers: [TailscaleController],
  providers: [TailscaleService],
  exports: [TailscaleService]
})
export class TailscaleModule {}
