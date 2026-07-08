import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationChannelsController } from './notification-channels.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Global()
@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule],
  controllers: [NotificationChannelsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
