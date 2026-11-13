import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { EventsController } from '../src/events/events.controller';
import { OrgEventsService } from '../src/events/org-events.service';
import { PrismaEventsBridge } from '../src/events/prisma-events.bridge';
import { SseStreamLimiter } from '../src/events/sse-stream-limiter';
import { MembershipCacheService } from '../src/auth/membership-cache.service';

const ORG = 'org-1';
const USER = 'user-1';

function orgEventsFor() {
  const bus: any = {
    enabled: false,
    setConsumer: () => {},
    publish: async () => {},
    replay: async () => []
  };
  return new OrgEventsService({} as any, bus);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function controllerWith(authz: any, orgEvents: OrgEventsService) {
  const limiter = new SseStreamLimiter();
  const streams: any = {
    acquire: () => () => {},
    untilAccessLost: (auth: any, fn: () => Promise<unknown>) =>
      limiter.untilAccessLost(auth, fn, 10)
  };
  const memberships: any = { getMembershipsForOrg: async () => [{ organizationId: ORG }] };
  return new EventsController(orgEvents, memberships, authz, streams);
}

test('the org stream ends once the user stops being a member', async () => {
  const orgEvents = orgEventsFor();
  let calls = 0;
  const authz: any = {
    isUnrestrictedSuperAdmin: async () => false,
    listVisibleProjectIds: async () => {
      calls += 1;
      if (calls > 1) throw new NotFoundException('Organization not found');
      return null;
    }
  };
  const ctrl = controllerWith(authz, orgEvents);
  const stream = await ctrl.streamOrg(ORG, undefined, {
    user: { sub: USER },
    headers: {},
    auth: {}
  });
  const received: any[] = [];
  const done = new Promise<void>((resolve) =>
    stream.subscribe({ next: (m) => received.push(m), complete: resolve })
  );
  await Promise.race([done, sleep(500).then(() => assert.fail('stream stayed open'))]);
  orgEvents.emitLocal({ organizationId: ORG, type: 'project.changed', id: 'p1', projectId: 'p1' });
  assert.equal(received.filter((m) => m.data?.type === 'project.changed').length, 0);
});

test('project visibility is refreshed mid-stream', async () => {
  const orgEvents = orgEventsFor();
  let visible: string[] = ['p1'];
  const authz: any = {
    isUnrestrictedSuperAdmin: async () => false,
    listVisibleProjectIds: async () => visible
  };
  const ctrl = controllerWith(authz, orgEvents);
  const stream = await ctrl.streamOrg(ORG, undefined, {
    user: { sub: USER },
    headers: {},
    auth: {}
  });
  const received: string[] = [];
  const sub = stream.subscribe({
    next: (m: any) => {
      if (m.data?.type === 'project.changed') received.push(m.data.projectId);
    }
  });
  orgEvents.emitLocal({ organizationId: ORG, type: 'project.changed', id: 'p1', projectId: 'p1' });
  visible = [];
  await sleep(60);
  orgEvents.emitLocal({ organizationId: ORG, type: 'project.changed', id: 'p1', projectId: 'p1' });
  sub.unsubscribe();
  assert.deepEqual(received, ['p1']);
});

test('membership.changed for the user closes their stream and strangers do not see it', () => {
  const orgEvents = orgEventsFor();
  const mine: any[] = [];
  const theirs: any[] = [];
  let mineDone = false;
  orgEvents
    .forOrgAsSseScoped(ORG, USER, ['p1'])
    .subscribe({ next: (m) => mine.push(m.data.type), complete: () => (mineDone = true) });
  orgEvents
    .forOrgAsSseScoped(ORG, 'other', ['p1'])
    .subscribe({ next: (m) => theirs.push(m.data.type) });
  orgEvents.emitLocal({ organizationId: ORG, type: 'membership.changed', id: USER });
  assert.equal(mineDone, true);
  assert.deepEqual(mine, ['membership.changed']);
  assert.deepEqual(theirs, []);
});

function bridgeWith(resolveOrg: string | null) {
  const membershipCache = new MembershipCacheService({} as any);
  const emitted: any[] = [];
  const orgEvents: any = {
    emit: (e: any) => {
      emitted.push(e);
    }
  };
  const prisma: any = {
    $extends: () => ({}),
    project: { findUnique: async () => (resolveOrg ? { organizationId: resolveOrg } : null) }
  };
  const bridge = new PrismaEventsBridge(prisma, orgEvents, membershipCache, {} as any);
  bridge.onModuleInit();
  return { bridge: bridge as any, membershipCache, emitted };
}

test('a transactional membership delete reports revocation through the cache hook', () => {
  const { membershipCache, emitted } = bridgeWith(ORG);
  membershipCache.revoked(ORG, USER);
  assert.deepEqual(emitted, [{ organizationId: ORG, type: 'membership.changed', id: USER }]);
});

test('project member writes emit membership.changed for the affected user', async () => {
  const { bridge, emitted } = bridgeWith(ORG);
  await bridge.handle(
    { model: 'ProjectMember', action: 'create', args: {} },
    { userId: USER, projectId: 'p1' }
  );
  assert.deepEqual(emitted, [{ organizationId: ORG, type: 'membership.changed', id: USER }]);
});
