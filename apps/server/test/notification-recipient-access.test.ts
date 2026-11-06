import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationFanoutService } from '../src/notifications/notification-fanout.service';
import { NotificationDeliveryService } from '../src/notifications/notification-delivery.service';
import {
  NotificationAccessService,
  REDACTED_BODY
} from '../src/notifications/notification-access.service';

const access = (canEdit: boolean) => ({
  projectId: 'p1',
  organizationId: 'o1',
  source: 'projectMember',
  orgRole: 'member',
  projectRoleName: canEdit ? 'editor' : 'viewer',
  canView: true,
  canEdit,
  canManageMembers: false,
  canDelete: false
});

function authzFor(map: Record<string, any>) {
  const calls: string[] = [];
  return {
    calls,
    getProjectAccess: async (_p: string, userId: string) => {
      calls.push(userId);
      return map[userId] ?? null;
    }
  };
}

function fanoutWith(authz: any) {
  const prisma: any = {
    projectMember: { findMany: async () => [{ userId: 'viewer' }, { userId: 'removed' }] },
    project: { findUnique: async () => ({ ownerId: 'editor', createdBy: 'removed' }) },
    organizationMember: { findMany: async () => [{ userId: 'admin' }] },
    userNotificationSetting: {
      findMany: async (args: any) =>
        args.where.userId.in.map((u: string) => ({
          userId: u,
          scopeType: 'global',
          value: 'always'
        }))
    },
    userNotificationDestination: {
      findMany: async (args: any) =>
        args.where.userId.in.map((u: string) => ({ id: `d-${u}`, userId: u }))
    }
  };
  return new NotificationFanoutService(prisma, {} as any, new NotificationAccessService(authz));
}

const chain = {
  organizationId: 'o1',
  projectId: 'p1',
  resourceType: 'deployment',
  resourceId: 'dep1',
  projectOwnerId: 'editor',
  resourceCreatorId: 'removed'
};
const event = {
  id: 'e1',
  organizationId: 'o1',
  event: 'deploy.failed',
  scopeType: 'deployment',
  scopeId: 'dep1',
  projectId: 'p1',
  actorUserId: 'removed',
  payload: {}
};

test('personal lane skips removed members and keeps current members', async () => {
  const authz = authzFor({
    viewer: access(false),
    editor: access(true),
    admin: { ...access(true), source: 'orgAdmin' }
  });
  const svc: any = fanoutWith(authz);
  const dests = await svc.resolvePersonalLane(event, chain);
  const users = dests.map((d: any) => d.userId).sort();
  assert.deepEqual(users, ['admin', 'editor', 'viewer']);
  assert.ok(!users.includes('removed'));
});

test('personal lane for an account-scoped event does not consult project access', async () => {
  const authz = authzFor({});
  const svc: any = fanoutWith(authz);
  const userChain = {
    ...chain,
    projectId: null,
    organizationId: null,
    resourceType: 'user',
    resourceId: 'u9'
  };
  const dests = await svc.resolvePersonalLane(
    { ...event, scopeType: 'user', projectId: null, event: 'deploy.failed' },
    userChain
  );
  assert.equal(authz.calls.length, 0);
  assert.deepEqual(
    dests.map((d: any) => d.userId),
    ['u9']
  );
});

test('access lookups are cached across fan-outs', async () => {
  const authz = authzFor({ viewer: access(false) });
  const svc = new NotificationAccessService(authz as any);
  await svc.resolve('p1', 'viewer');
  await svc.resolve('p1', 'viewer');
  assert.equal(authz.calls.length, 1);
});

function deliveryWith(authz: any) {
  const marked: any[] = [];
  const prisma: any = {
    notificationDelivery: { updateMany: async (a: any) => void marked.push(a) }
  };
  const svc: any = new NotificationDeliveryService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    new NotificationAccessService(authz)
  );
  return { svc, marked };
}

const delivery = (userId: string | null) => ({
  id: `del-${userId}`,
  eventId: 'e1',
  destinationKey: `userdest:${userId}`,
  channelId: null,
  userDestId: userId ? `d-${userId}` : null,
  userId,
  projectId: 'p1',
  event: 'deploy.failed',
  targetId: 'dep1',
  attempts: 0,
  payload: {
    event: 'deploy.failed',
    title: 'Deploy failed',
    body: 'secret build error: token=abc',
    fields: [
      { name: 'Branch', value: 'main' },
      { name: 'Reason', value: 'secret reason' }
    ]
  }
});

test('delivery drops a recipient who lost access', async () => {
  const { svc, marked } = deliveryWith(authzFor({}));
  const kept = await svc.enforceRecipientAccess([delivery('removed')]);
  assert.equal(kept.length, 0);
  assert.equal(marked[0].data.status, 'dropped');
});

test('delivery redacts error text for a viewer and keeps it for an editor', async () => {
  const { svc } = deliveryWith(authzFor({ viewer: access(false), editor: access(true) }));
  const [v, e] = await svc.enforceRecipientAccess([delivery('viewer'), delivery('editor')]);
  assert.equal(v.payload.body, REDACTED_BODY);
  assert.deepEqual(v.payload.fields, [{ name: 'Branch', value: 'main' }]);
  assert.match(e.payload.body, /secret build error/);
});

test('team-channel deliveries are not subject to recipient checks', async () => {
  const authz = authzFor({});
  const { svc } = deliveryWith(authz);
  const channelDelivery = { ...delivery(null), channelId: 'c1' };
  const kept = await svc.enforceRecipientAccess([channelDelivery]);
  assert.equal(kept.length, 1);
  assert.equal(authz.calls.length, 0);
});
