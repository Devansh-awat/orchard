import { Module } from '@nestjs/common';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';
import { NodePoolsService } from './node-pools.service';
import { NodePoolsController, UserNodePoolsController } from './node-pools.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';

@Module({
  imports: [PrismaModule, AuthModule, KubernetesModule],
  controllers: [NodesController, NodePoolsController, UserNodePoolsController],
  providers: [NodesService, NodePoolsService],
  exports: [NodesService, NodePoolsService],
})
export class NodesModule {}
