import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRuleLane,
  resolveSettingValue,
  shouldNotifyUser
} from '../src/notifications/notification-resolution';
import {
  CATEGORY_DEFAULT_VALUE,
  EVENT_CATEGORY,
  NOTIFICATION_EVENTS,
  RULE_SCOPE_TYPES,
  teamRoutableEvents,
  eventsForScopeType
} from '../src/notifications/notification-events';
import { backupKey, deployKey, jobRunKey, podKey } from '../src/notifications/dedupe-keys';
import type { ResolvedScope } from '../src/notifications/notification-scope';
import {
  isChannelVisibleAt,
  ownsChannel,
  scopeChain
} from '../src/notifications/notification-scope';
import { readFile } from 'node:fs/promises';

const DEPLOY = 'deploy.failed';

const ORG_SCOPE: ResolvedScope = { scopeType: 'org', scopeId: null, projectId: null, label: 'org' };
const PROJECT_SCOPE: ResolvedScope = {
  scopeType: 'project',
  scopeId: 'p1',
  projectId: 'p1',
  label: 'project'
};
const DEPLOYMENT_SCOPE: ResolvedScope = {
  scopeType: 'deployment',
  scopeId: 'd1',
  projectId: 'p1',
  label: 'app'
};

test('an org rule delivers to its channel', () => {
  const channels = resolveRuleLane(
    [{ channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' }],
    DEPLOY
  );
  assert.deepEqual(channels, ['c1']);
});

test('a rule that does not list the event is ignored', () => {
  const channels = resolveRuleLane(
    [{ channelId: 'c1', scopeType: 'org', events: ['deploy.succeeded'], mode: 'deliver' }],
    DEPLOY
  );
  assert.deepEqual(channels, []);
});

test('two rules pointing at one channel produce a single delivery', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'deliver' }
    ],
    DEPLOY
  );
  assert.deepEqual(channels, ['c1']);
});

test('a deployment mute beats an org deliver on the same channel', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'mute' }
    ],
    DEPLOY
  );
  assert.deepEqual(channels, []);
});

test('a mute only silences the channel it names', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c2', scopeType: 'org', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'mute' }
    ],
    DEPLOY
  );
  assert.deepEqual(channels, ['c2']);
});

test('an org mute does not override a deployment deliver', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'org', events: [DEPLOY], mode: 'mute' },
      { channelId: 'c1', scopeType: 'deployment', events: [DEPLOY], mode: 'deliver' }
    ],
    DEPLOY
  );
  assert.deepEqual(channels, ['c1']);
});

test('a mute at the same scope wins over a deliver at that scope', () => {
  const channels = resolveRuleLane(
    [
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'deliver' },
      { channelId: 'c1', scopeType: 'project', events: [DEPLOY], mode: 'mute' }
    ],
    DEPLOY
  );
  assert.deepEqual(channels, []);
});

test('no settings means the system default', () => {
  assert.equal(resolveSettingValue([], 'u1'), 'subscribed');
});

test('the most specific scope wins', () => {
  const settings = [
    { userId: 'u1', scopeType: 'global', value: 'never' },
    { userId: 'u1', scopeType: 'project', value: 'always' }
  ];
  assert.equal(resolveSettingValue(settings, 'u1'), 'always');
  const reversed = [
    { userId: 'u1', scopeType: 'global', value: 'always' },
    { userId: 'u1', scopeType: 'deployment', value: 'never' }
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
    { userId: 'u1', scopeType: 'project', value: 'always' }
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
    'alert.firing',
    'alert.resolved',
    'deploy.failed',
    'deploy.regressed',
    'deploy.succeeded',
    'pod.crashing',
    'pod.recovered'
  ]);
  assert.ok(eventsForScopeType('database').includes('backup.failed'));
  assert.ok(!eventsForScopeType('database').includes('deploy.failed'));
  assert.deepEqual(eventsForScopeType('org').length, teamRoutableEvents().length);
});

// A team channel belongs to an organization; a sign-in belongs to a person.
// There is no scope at which it is acceptable to route one to the other, so the
// rule editor is never offered the option in the first place.
test('no rule scope can subscribe a shared channel to a security event', () => {
  for (const scopeType of RULE_SCOPE_TYPES) {
    for (const event of eventsForScopeType(scopeType)) {
      assert.notEqual(EVENT_CATEGORY[event], 'security', `${scopeType} rules are offered ${event}`);
    }
  }
});

test('security is on until someone turns it off', () => {
  assert.equal(CATEGORY_DEFAULT_VALUE.security, 'always');
  assert.equal(
    shouldNotifyUser('u1', [], NOBODY, CATEGORY_DEFAULT_VALUE.security),
    true,
    'a brand new account hears about its own sign-ins'
  );
});

test('turning security off silences it even though the event is yours', () => {
  const off = [{ userId: 'u1', scopeType: 'global', value: 'never' }];
  assert.equal(shouldNotifyUser('u1', off, { ...NOBODY, actorUserId: 'u1' }, 'always'), false);
});

// The account-scoped events carry actorUserId = the account, so even a stored
// 'subscribed' delivers. Worth pinning: it is what lets the two-state control
// in the UI sit on top of a three-value column without a special case.
test('a stored subscribed still delivers a security event', () => {
  const sub = [{ userId: 'u1', scopeType: 'global', value: 'subscribed' }];
  assert.equal(shouldNotifyUser('u1', sub, { ...NOBODY, actorUserId: 'u1' }, 'always'), true);
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
    'utf8'
  );
  const seeder = src.slice(src.indexOf('async ensureEmailDestination'));
  const body = seeder.slice(0, seeder.indexOf('\n  async ', 1));
  assert.ok(
    /data:\s*\{\s*userId,\s*type:\s*'email',\s*config:\s*\{\},\s*enabled\s*\}/.test(body),
    'ensureEmailDestination must create the row with the caller-supplied enabled flag'
  );
  assert.ok(
    /async ensureEmailDestination\(userId: string, enabled = false\)/.test(body),
    'that flag must default to false, so a GET of the settings page cannot enrol anyone'
  );
});

test('fanout only ever delivers to destinations that are enabled', async () => {
  const src = await readFile(
    new URL('../src/notifications/notification-fanout.service.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    src,
    /userNotificationDestination\.findMany\(\{\s*where:\s*\{\s*userId:\s*\{\s*in:\s*wanted\s*\},\s*enabled:\s*true\s*\}/,
    'the personal lane must filter on enabled: true'
  );
});

// Scoped destinations. An app admin can now create the webhook their app sends
// to, so the tests below pin the two things that keeps honest: what a scope may
// route to, and what it may edit.
test('a scope inherits from the org and its project, outermost first', () => {
  assert.deepEqual(scopeChain(ORG_SCOPE), [{ scopeType: 'org', scopeId: null }]);
  assert.deepEqual(scopeChain(PROJECT_SCOPE), [
    { scopeType: 'org', scopeId: null },
    { scopeType: 'project', scopeId: 'p1' }
  ]);
  assert.deepEqual(scopeChain(DEPLOYMENT_SCOPE), [
    { scopeType: 'org', scopeId: null },
    { scopeType: 'project', scopeId: 'p1' },
    { scopeType: 'deployment', scopeId: 'd1' }
  ]);
});

test('an app can route to the org and project destinations it inherits', () => {
  assert.ok(isChannelVisibleAt(DEPLOYMENT_SCOPE, { scopeType: 'org', scopeId: null }));
  assert.ok(isChannelVisibleAt(DEPLOYMENT_SCOPE, { scopeType: 'project', scopeId: 'p1' }));
  assert.ok(isChannelVisibleAt(DEPLOYMENT_SCOPE, { scopeType: 'deployment', scopeId: 'd1' }));
});

test("an app cannot route to another app's private destination", () => {
  assert.ok(!isChannelVisibleAt(DEPLOYMENT_SCOPE, { scopeType: 'deployment', scopeId: 'd2' }));
  assert.ok(!isChannelVisibleAt(DEPLOYMENT_SCOPE, { scopeType: 'project', scopeId: 'p2' }));
  // Ownership does not flow upwards: the project is not entitled to what one of
  // its deployments made, or the org-wide picker would fill with app webhooks.
  assert.ok(!isChannelVisibleAt(PROJECT_SCOPE, { scopeType: 'deployment', scopeId: 'd1' }));
  assert.ok(!isChannelVisibleAt(ORG_SCOPE, { scopeType: 'project', scopeId: 'p1' }));
});

test('only the owning scope may edit a destination', () => {
  assert.ok(ownsChannel(DEPLOYMENT_SCOPE, { scopeType: 'deployment', scopeId: 'd1' }));
  assert.ok(!ownsChannel(DEPLOYMENT_SCOPE, { scopeType: 'org', scopeId: null }));
  assert.ok(!ownsChannel(DEPLOYMENT_SCOPE, { scopeType: 'project', scopeId: 'p1' }));
  assert.ok(ownsChannel(ORG_SCOPE, { scopeType: 'org', scopeId: null }));
});

test('a rule may not point at a destination its scope cannot see', async () => {
  const src = await readFile(
    new URL('../src/notifications/notification-rules.service.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    src,
    /if \(!isChannelVisibleAt\(scope, channel\)\) \{\s*throw new NotFoundException/,
    'createRule must reject a channel that is not visible at the rule scope'
  );
});

test('the scoped destination list never hands out a webhook url', async () => {
  const src = await readFile(
    new URL('../src/notifications/notification-channels.service.ts', import.meta.url),
    'utf8'
  );
  const method = src.slice(src.indexOf('async listChannelsForScope'));
  const body = method.slice(0, method.indexOf('\n  async ', 1));
  assert.ok(!/config/.test(body), 'listChannelsForScope must not select or return channel config');
});

test('writing to a destination is gated by the scope that owns it', async () => {
  const src = await readFile(
    new URL('../src/notifications/notification-channels.controller.ts', import.meta.url),
    'utf8'
  );
  for (const handler of [
    'updateChannel',
    'deleteChannel',
    'testChannel',
    'replayChannel',
    'listDeliveries'
  ]) {
    const rest = src.slice(src.indexOf(`async ${handler}(`));
    const end = rest.indexOf('\n  @');
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.ok(body.length > 0 && body.length < 1200, `could not isolate ${handler}`);
    assert.match(
      body,
      /requireChannelScope\(/,
      `${handler} must authorize against the channel's own scope`
    );
    assert.ok(
      !/requireAdmin\(/.test(body),
      `${handler} must not fall back to an org-wide admin check`
    );
  }
  assert.match(
    src.slice(src.indexOf('async createChannel(')),
    /assertCanEditScope\(organizationId, scope, user\)/,
    'creating a destination must check admin on the scope it is being attached to'
  );
});
