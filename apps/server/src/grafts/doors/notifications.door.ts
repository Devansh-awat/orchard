import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import {
  registerNotificationEvent,
  type NotificationEventDefinition,
  type NotificationMessage
} from '../../notifications/notification-events';
import { NotificationsService } from '../../notifications/notifications.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class NotificationsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'notifications',
    version: 1,
    status: 'stable',
    capability: 'notifications'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(NotificationsService) private readonly notifications: NotificationsService
  ) {
    this.graft = bindGraft(parent, NotificationsDoorV1.meta);
  }

  registerEvent(def: NotificationEventDefinition): void {
    assertClaimed(this.graft, 'notificationEvents', def.event, 'notification event');
    assertClaimed(this.graft, 'notificationCategories', def.category, 'notification category');
    registerNotificationEvent(def);
  }

  notifyAccount(userId: string, message: NotificationMessage, dedupeKey: string) {
    assertClaimed(this.graft, 'notificationEvents', message.event, 'notification event');
    return this.notifications.notifyAccount(userId, message, dedupeKey);
  }
}
