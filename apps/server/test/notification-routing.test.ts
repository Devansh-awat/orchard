import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRuleLane,
  resolveSettingValue,
  shouldNotifyUser,
} from '../src/notifications/notification-resolution';
import {
  EVENT_CATEGORY,
  NOTIFICATION_EVENTS,
  eventsForScopeType,
} from '../src/notifications/notification-events';
import { backupKey, deployKey, jobRunKey, podKey } from '../src/notifications/dedupe-keys';
import { readFile } from 'node:fs/promises';

const DEPLOY = 'deploy.failed';

test('an org rule delivers to its channel', () => {
  const channels = resolveRuleLane(
    [{ channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' }],
    DEPLOY,
  );
  assert.deepEqual(channels, ['c1']);
});

test('a rule that does not list the event is ignored', () => {
  const channels = resolveRuleLane(
    [{ channelId: 'c1', scopeType: 'org', events: ['deploy.succeeded'], mode: 'deliver' }],
    DEPLOY,
  );
  assert.deepEqual(channels, []);
});

test('two rules pointing at one channel produce a single delivery', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'deliver' },
    ],
    DEPLOY,
  );
  assert.deepEqual(channels, ['c1']);
});

test('a deployment mute beats an org deliver on the same channel', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'mute' },
    ],
    DEPLOY,
  );
  assert.deepEqual(channels, []);
});

test('a mute only silences the channel it names', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c2', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'mute' },
    ],
    DEPLOY,
  );
  assert.deepEqual(channels, ['c2']);
});

test('an org mute does not override a deployment deliver', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'mute' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'deliver' },
    ],
    DEPLOY,
  );
  assert.deepEqual(channels, ['c1']);
});

test('a mute at the same scope wins over a deliver at that scope', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'mute' },
    ],
    DEPLOY,
  );
  assert.deepEqual(channels, []);
});

test('no settings means the system default', () => {
  assert.equal(resolveSettingValue([], 'u1'), 'subscribed');
});

test('the most specific scope wins', () => {
  const settings = [
    { userId: 'u1', scopeType: 'global', value: 'never' },
    { userId: 'u1', scopeType: 'project', value: 'always' },
  ];
  assert.equal(resolveSettingValue(settings, 'u1'), 'always');
  const reversed = [
    { userId: 'u1', scopeType: 'global', value: 'always' },
    { userId: 'u1', scopeType: 'deployment', value: 'never' },
  ];
  assert.equal(resolveSettingValue(reversed, 'u1'), 'never');
});

test("one user's settings never leak into another's", () => {
  const settings = [{ userId: 'u2', scopeType: 'global', value: 'never' }];
  assert.equal(resolveSettingValue(settings, 'u1'), 'subscribed');
});

const NOBODY = { actorUserId: null, resourceCreatorId: null, projectOwnerId: null };

test('global never plus a project always still delivers', () => {
  const settings = [
    { userId: 'u1', scopeType: 'global', value: 'never' },
    { userId: 'u1', scopeType: 'project', value: 'always' },
  ];
  assert.equal(shouldNotifyUser('u1', settings, NOBODY), true);
});

test('subscribed only fires for someone actually involved', () => {
  assert.equal(shouldNotifyUser('u1', [], NOBODY), false);
  assert.equal(shouldNotifyUser('u1', [], { ...NOBODY, actorUserId: 'u1' }), true);
  assert.equal(shouldNotifyUser('u1', [], { ...NOBODY, resourceCreatorId: 'u1' }), true);
  assert.equal(shouldNotifyUser('u1', [], { ...NOBODY, projectOwnerId: 'u1' }), true);
});

test('always fires for a bystander, never does not', () => {
  const always = [{ userId: 'u1', scopeType: 'global', value: 'always' }];
  assert.equal(shouldNotifyUser('u1', always, NOBODY), true);
  const never = [{ userId: 'u1', scopeType: 'global', value: 'never' }];
  assert.equal(shouldNotifyUser('u1', never, { ...NOBODY, actorUserId: 'u1' }), false);
});

test('every event belongs to exactly one category', () => {
  for (const event of NOTIFICATION_EVENTS) {
    assert.ok(EVENT_CATEGORY[event], `${event} has no category`);
  }
});

test('resource scopes only accept events that can happen there', () => {
  assert.deepEqual(eventsForScopeType('deployment').sort(), [
    'deploy.failed',
    'deploy.succeeded',
    'pod.crashing',
    'pod.recovered',
  ]);
  assert.ok(eventsForScopeType('database').includes('backup.failed'));
  assert.ok(!eventsForScopeType('database').includes('deploy.failed'));
  assert.deepEqual(eventsForScopeType('org').length, NOTIFICATION_EVENTS.length);
});

test('dedupe keys are stable for one transition and distinct across transitions', () => {
  assert.equal(deployKey('d1', 'failed', 'run1', 0), deployKey('d1', 'failed', 'run1', 999));
  assert.notEqual(deployKey('d1', 'failed', 'run1', 0), deployKey('d1', 'failed', 'run2', 0));
  assert.notEqual(deployKey('d1', 'failed', 'run1', 0), deployKey('d1', 'succeeded', 'run1', 0));
  assert.equal(podKey('d1', 'crashing'), podKey('d1', 'crashing'));
  assert.notEqual(podKey('d1', 'crashing'), podKey('d1', 'recovered'));
  assert.notEqual(backupKey('b1', 'failed'), backupKey('b1', 'completed'));
  assert.notEqual(jobRunKey('r1', 'failed'), jobRunKey('r2', 'failed'));
});

test('dedupe keys fit the column', () => {
  const long = 'x'.repeat(400);
  assert.ok(deployKey(long, 'failed', long, 0).length <= 200);
});

// Consent. shouldNotifyUser deciding "yes" only picks the person; whether any
// mail leaves depends on them having enabled a destination, which is why the
// service seeds the email row disabled. These pin both halves so neither can
// quietly flip back to opt-out.
test('the personal email destination is seeded disabled', async () => {
  const src = await readFile(
    new URL('../src/notifications/user-notifications.service.ts', import.meta.url),
    'utf8',
  );
  const seeder = src.slice(src.indexOf('async ensureEmailDestination'));
  const body = seeder.slice(0, seeder.indexOf('\n  async ', 1));
  assert.ok(
    /data:\s*\{\s*userId,\s*type:\s*'email',\s*config:\s*\{\},\s*enabled\s*\}/.test(body),
    'ensureEmailDestination must create the row with the caller-supplied enabled flag',
  );
  assert.ok(
    /async ensureEmailDestination\(userId: string, enabled = false\)/.test(body),
    'that flag must default to false, so a GET of the settings page cannot enrol anyone',
  );
});

test('fanout only ever delivers to destinations that are enabled', async () => {
  const src = await readFile(
    new URL('../src/notifications/notification-fanout.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    src,
    /userNotificationDestination\.findMany\(\{\s*where:\s*\{\s*userId:\s*\{\s*in:\s*wanted\s*\},\s*enabled:\s*true\s*\}/,
    'the personal lane must filter on enabled: true',
  );
});
