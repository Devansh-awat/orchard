import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Subject, filter, map } from 'rxjs';
import {
  RolloutStatusService,
  parseRolloutSince,
  parseRolloutTimeout,
  tailLines,
  ROLLOUT_WAIT_MAX_MS
} from '../src/projects/rollout-status.service';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';

function readyPod(name: string) {
  return {
    metadata: { name, creationTimestamp: new Date(Date.now() - 3_600_000).toISOString() },
    status: {
      phase: 'Running',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Ready', status: 'True' }
      ],
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }]
    }
  };
}

function crashPod(name: string) {
  return {
    metadata: { name, creationTimestamp: new Date().toISOString() },
    status: {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [
        {
          name: 'app',
          ready: false,
          restartCount: 3,
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { reason: 'Error', exitCode: 1 } }
        }
      ]
    }
  };
}

interface World {
  deployment: Record<string, any>;
  pods: any[];
  runs: any[];
  releases: any[];
  buildLogs: string;
  ingresses: any[];
  evaluations: number;
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    deployment: {
      name: 'web',
      namespace: 'ns',
      stopped: false,
      replicas: 1,
      image: 'registry.local/web:v1',
      buildStatus: 'succeeded',
      buildStep: 'complete',
      buildError: null,
      updatedAt: new Date(Date.now() - 3_600_000)
    },
    pods: [readyPod('web-1')],
    runs: [],
    releases: [],
    buildLogs: '',
    ingresses: [],
    evaluations: 0,
    ...over
  };
}

function makeService(world: World, opts: { podLogs?: string } = {}) {
  const events = new Subject<{ type: string; id: string }>();
  const prisma = {
    deployment: {
      findUnique: async () => {
        world.evaluations++;
        return { ...world.deployment };
      }
    },
    buildRun: { findMany: async () => world.runs },
    k8sObject: {
      findFirst: async () => null,
      findMany: async () => world.pods.map((manifest) => ({ manifest }))
    },
    release: {
      findFirst: async (args: any) => {
        const gte: Date | undefined = args.where.createdAt?.gte;
        const rows = world.releases.filter(
          (r) => (!args.where.id || r.id === args.where.id) && (!gte || r.createdAt >= gte)
        );
        return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      },
      count: async () => 0
    },
    ingress: { findMany: async () => world.ingresses },
    $queryRaw: async () => [{ tail: world.buildLogs }]
  };
  const k8s = {
    getPodLogs: async (_pod: string, _ns: string, _c: string, _n: number, previous: boolean) => ({
      logs: previous ? (opts.podLogs ?? '') : ''
    })
  };
  const capture = { list: async () => [], getLogs: async () => null };
  const orgEvents = {
    forDeployment: (type: string, id: string) =>
      events.pipe(
        filter((e) => e.type === type && e.id === id),
        map((e) => e)
      )
  };
  const service = new RolloutStatusService(
    prisma as any,
    k8s as any,
    capture as any,
    orgEvents as any
  );
  return { service, events };
}

test('tailLines keeps the last n lines without trailing blanks', () => {
  assert.deepEqual(tailLines('a\nb\nc\n\n', 2), ['b', 'c']);
  assert.deepEqual(tailLines(null, 5), []);
  assert.deepEqual(tailLines('x\r\ny', 5), ['x', 'y']);
});

test('timeout defaults to 60s, is capped at 120s, and rejects junk', () => {
  assert.equal(parseRolloutTimeout(undefined), 60_000);
  assert.equal(parseRolloutTimeout('5'), 5_000);
  assert.equal(parseRolloutTimeout('900'), ROLLOUT_WAIT_MAX_MS);
  assert.throws(() => parseRolloutTimeout('abc'));
  assert.throws(() => parseRolloutTimeout('0'));
});

test('since accepts ISO and epoch milliseconds', () => {
  assert.equal(parseRolloutSince('1700000000000')?.getTime(), 1_700_000_000_000);
  assert.equal(
    parseRolloutSince('2026-10-27T12:00:00Z')?.toISOString(),
    '2026-10-27T12:00:00.000Z'
  );
  assert.equal(parseRolloutSince(undefined), null);
  assert.throws(() => parseRolloutSince('not-a-date'));
});

test('a live deployment answers immediately with its url and latest release', async () => {
  const world = makeWorld({
    releases: [{ id: RELEASE_ID, createdAt: new Date(), image: 'x', status: 'live', reason: null }],
    ingresses: [
      {
        host: 'web.example.dev',
        path: '/',
        tlsSecretName: 'web-tls',
        tlsHosts: ['web.example.dev'],
        entrypoints: []
      }
    ]
  });
  const { service } = makeService(world);
  const r = await service.rollout(DEPLOYMENT_ID, { canEdit: true, wait: true, timeoutMs: 5_000 });
  assert.equal(r.phase, 'live');
  assert.equal(r.terminal, true);
  assert.equal(r.releaseId, RELEASE_ID);
  assert.match(r.url ?? '', /^https:\/\/web\.example\.dev/);
  assert.equal(world.evaluations, 1);
});

test('a failed build carries the error and log tail to editors only', async () => {
  const logs = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const world = makeWorld({
    deployment: {
      ...makeWorld().deployment,
      buildStatus: 'failed',
      buildStep: 'build',
      buildError: 'npm ERR! missing script: build'
    },
    buildLogs: logs
  });
  const { service } = makeService(world);
  const editor = await service.rollout(DEPLOYMENT_ID, {
    canEdit: true,
    wait: false,
    timeoutMs: 1_000
  });
  assert.equal(editor.phase, 'build_failed');
  assert.equal(editor.build.error, 'npm ERR! missing script: build');
  assert.equal(editor.build.logTail.length, 40);
  assert.equal(editor.build.logTail[39], 'line 59');

  const viewer = await service.rollout(DEPLOYMENT_ID, {
    canEdit: false,
    wait: false,
    timeoutMs: 1_000
  });
  assert.equal(viewer.phase, 'build_failed');
  assert.equal(viewer.build.error, null);
  assert.deepEqual(viewer.build.logTail, []);
});

test('a failed build with no stored error gets a summary from its logs', async () => {
  const world = makeWorld({
    deployment: { ...makeWorld().deployment, buildStatus: 'failed', buildError: null },
    buildLogs: [
      '#7 0.5 Error: Cannot find module "express"',
      '#7 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'
    ].join('\n')
  });
  const { service } = makeService(world);
  const r = await service.rollout(DEPLOYMENT_ID, { canEdit: true, wait: false, timeoutMs: 1_000 });
  assert.match(r.build.error ?? '', /Cannot find module/);
});

test('crashing pods come back with their log tail, and viewers get none', async () => {
  const world = makeWorld({ pods: [crashPod('web-2')] });
  const { service } = makeService(world, { podLogs: 'booting\nError: DATABASE_URL is not set\n' });
  const editor = await service.rollout(DEPLOYMENT_ID, {
    canEdit: true,
    wait: false,
    timeoutMs: 1_000
  });
  assert.equal(editor.phase, 'crashing');
  assert.equal(editor.pods.failing[0].pod, 'web-2');
  assert.equal(editor.pods.failing[0].reason, 'CrashLoopBackOff');
  assert.deepEqual(editor.pods.failing[0].logTail, ['booting', 'Error: DATABASE_URL is not set']);

  const viewer = await service.rollout(DEPLOYMENT_ID, {
    canEdit: false,
    wait: false,
    timeoutMs: 1_000
  });
  assert.equal(viewer.phase, 'crashing');
  assert.deepEqual(viewer.pods.failing[0].logTail, []);
});

test('wait wakes on a build event instead of sleeping out the poll', async () => {
  const world = makeWorld({
    deployment: { ...makeWorld().deployment, buildStatus: 'building', buildStep: 'build' }
  });
  const { service, events } = makeService(world);
  const started = Date.now();
  const pending = service.rollout(DEPLOYMENT_ID, { canEdit: true, wait: true, timeoutMs: 10_000 });
  await new Promise((r) => setTimeout(r, 50));
  world.deployment.buildStatus = 'failed';
  world.deployment.buildError = 'boom';
  events.next({ type: 'build.changed', id: DEPLOYMENT_ID });
  const r = await pending;
  assert.equal(r.phase, 'build_failed');
  assert.ok(Date.now() - started < 1_500, 'should not wait for the 2s poll');
});

test('wait ignores events for other deployments and returns at the timeout', async () => {
  const world = makeWorld({
    deployment: { ...makeWorld().deployment, buildStatus: 'building', buildStep: 'build' }
  });
  const { service, events } = makeService(world);
  const pending = service.rollout(DEPLOYMENT_ID, { canEdit: true, wait: true, timeoutMs: 300 });
  events.next({ type: 'build.changed', id: 'someone-else' });
  const r = await pending;
  assert.equal(r.phase, 'building');
  assert.equal(r.terminal, false);
});

test('a client disconnect ends the wait and drops the subscription', async () => {
  const world = makeWorld({
    deployment: { ...makeWorld().deployment, buildStatus: 'building', buildStep: 'build' }
  });
  const { service, events } = makeService(world);
  const abort = new AbortController();
  const started = Date.now();
  const pending = service.rollout(DEPLOYMENT_ID, {
    canEdit: true,
    wait: true,
    timeoutMs: 10_000,
    signal: abort.signal
  });
  await new Promise((r) => setTimeout(r, 30));
  abort.abort();
  const r = await pending;
  assert.equal(r.phase, 'building');
  assert.ok(Date.now() - started < 1_000);
  assert.equal(events.observed, false);
});

test('an unknown release pin is a 404', async () => {
  const { service } = makeService(makeWorld());
  await assert.rejects(
    service.rollout(DEPLOYMENT_ID, {
      canEdit: true,
      wait: false,
      timeoutMs: 1_000,
      releaseId: RELEASE_ID
    }),
    /Release not found/
  );
  await assert.rejects(
    service.rollout(DEPLOYMENT_ID, {
      canEdit: true,
      wait: false,
      timeoutMs: 1_000,
      releaseId: 'nope'
    }),
    /release must be a release id/
  );
});

test('a since pin right after a restart keeps waiting on the old pods', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const r = await service.rollout(DEPLOYMENT_ID, {
    canEdit: true,
    wait: false,
    timeoutMs: 1_000,
    since: new Date().toISOString()
  });
  assert.equal(r.phase, 'deploying');
  assert.equal(r.terminal, false);
});

test('rolloutPin returns the release recorded during the call', async () => {
  const before = new Date(Date.now() - 1_000);
  const world = makeWorld({
    releases: [{ id: RELEASE_ID, createdAt: new Date(), image: 'x', status: 'live', reason: null }]
  });
  const { service } = makeService(world);
  const pin = await service.rolloutPin(DEPLOYMENT_ID, before);
  assert.equal(pin.rolloutSince, before.toISOString());
  assert.equal(pin.releaseId, RELEASE_ID);
});
