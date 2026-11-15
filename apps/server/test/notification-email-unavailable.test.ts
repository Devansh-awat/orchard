import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { NotificationChannelsService } from '../src/notifications/notification-channels.service';
import { UserNotificationsService } from '../src/notifications/user-notifications.service';
import { EMAIL_UNAVAILABLE } from '../src/notifications/notification-transport';

const orgScope = { scopeType: 'org', scopeId: null, projectId: null, label: 'Org' } as never;
const actor = { id: 'u1', email: 'u1@example.com' } as never;

function channels(canSendEmail: boolean) {
  const writes: string[] = [];
  const prisma = {
    notificationChannel: {
      count: async () => 0,
      findFirst: async () => ({ id: 'c1', type: 'email', enabled: false, config: {} }),
      create: async () => {
        writes.push('create');
        return {};
      },
      update: async () => {
        writes.push('update');
        return {};
      }
    }
  };
  const svc = new NotificationChannelsService(
    prisma as never,
    { log: async () => undefined } as never,
    { canSendEmail: () => canSendEmail } as never,
    {} as never
  );
  return { svc, writes };
}

function destinations(canSendEmail: boolean) {
  const writes: string[] = [];
  const prisma = {
    userNotificationDestination: {
      findFirst: async () => ({ id: 'd1', type: 'email' }),
      create: async () => {
        writes.push('create');
        return { id: 'd1' };
      },
      update: async () => {
        writes.push('update');
        return {};
      }
    }
  };
  const svc = new UserNotificationsService(
    prisma as never,
    { canSendEmail: () => canSendEmail } as never,
    {} as never,
    {} as never
  );
  return { svc, writes };
}

const refused = (error: unknown) =>
  error instanceof BadRequestException && error.message === EMAIL_UNAVAILABLE;

test('an email channel is refused when the instance cannot send email', async () => {
  const { svc, writes } = channels(false);
  await assert.rejects(
    svc.createChannel(
      'o1',
      { name: 'Ops', type: 'email', config: { recipients: ['a@example.com'] } } as never,
      actor,
      orgScope
    ),
    refused
  );
  assert.deepEqual(writes, []);
});

test('turning an email channel back on is refused without email', async () => {
  const { svc, writes } = channels(false);
  await assert.rejects(
    svc.updateChannel('o1', 'c1', { enabled: true } as never, actor, orgScope),
    refused
  );
  assert.deepEqual(writes, []);
});

test('an email channel can still be turned off without email', async () => {
  const { svc, writes } = channels(false);
  await svc
    .updateChannel('o1', 'c1', { enabled: false } as never, actor, orgScope)
    .catch(() => undefined);
  assert.deepEqual(writes, ['update']);
});

test('personal email is refused when the instance cannot send email', async () => {
  const { svc, writes } = destinations(false);
  await assert.rejects(svc.addDestination('u1', { type: 'email' } as never), refused);
  await assert.rejects(svc.setDestinationEnabled('u1', 'd1', true), refused);
  assert.deepEqual(writes, []);
});

test('personal email can be turned off without email and on with it', async () => {
  const off = destinations(false);
  await off.svc.setDestinationEnabled('u1', 'd1', false);
  assert.deepEqual(off.writes, ['update']);

  const on = destinations(true);
  await on.svc.setDestinationEnabled('u1', 'd1', true);
  assert.deepEqual(on.writes, ['update']);
});
