import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationChannelsService } from './notification-channels.service';
import { NotificationRulesService } from './notification-rules.service';
import { UserNotificationsService } from './user-notifications.service';
import { NotificationFanoutService } from './notification-fanout.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationTransport } from './notification-transport';
import { NotificationRateLimiter } from './rate-limiter';
import { NotificationChannelsController } from './notification-channels.controller';
import { UserNotificationsController } from './user-notifications.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Global()
@Module({
  imports: [PrismaModule, AuthModule, UsersModule, OrganizationsModule],
  controllers: [NotificationChannelsController, UserNotificationsController],
  providers: [
    NotificationsService,
    NotificationChannelsService,
    NotificationRulesService,
    UserNotificationsService,
    NotificationFanoutService,
    NotificationDeliveryService,
    NotificationTransport,
    NotificationRateLimiter,
  ],
  exports: [NotificationsService, NotificationRulesService, UserNotificationsService],
})
export class NotificationsModule {}
