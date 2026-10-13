import { Inject, Injectable } from '@nestjs/common';
import { Doors, type NotificationsDoor } from '@orchard/graft-sdk/server';

export const SANDBOX_NEEDS_INPUT_EVENT = 'sandbox.session.needs_input';

@Injectable()
export class NotificationsService {
  constructor(@Inject(Doors.notifications) private readonly notifications: NotificationsDoor) {
    this.notifications.registerEvent({
      event: SANDBOX_NEEDS_INPUT_EVENT,
      category: 'agents',
      categoryLabel: 'Greenhouse sessions',
      categoryDefault: 'always',
      categoryOptions: ['always', 'never'],
      categoryCopy: {
        always: { label: 'On', hint: 'Told when an agent session is waiting for you' },
        never: { label: 'Off', hint: 'No alerts when an agent session is waiting for you' }
      },
      scope: 'user',
      tone: 'notice'
    });
  }

  async notifyAccount(
    userId: string,
    message: Parameters<NotificationsDoor['notifyAccount']>[1],
    dedupeKey: string
  ): Promise<unknown> {
    return this.notifications.notifyAccount(userId, message, dedupeKey);
  }
}
