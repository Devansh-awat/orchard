import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [KubernetesModule, UsersModule, AuthModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService]
})
export class WebhooksModule {}
