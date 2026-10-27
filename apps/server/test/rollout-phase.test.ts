import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRolloutPhase,
  describeFailingPod,
  PIN_GRACE_MS,
  INTENT_GRACE_MS,
  type RolloutState
} from '../src/projects/rollout-phase';

const NOW = new Date('2026-10-27T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function readyPod(name: string, created = ago(3_600_000)) {
  return {
    metadata: { name, creationTimestamp: created.toISOString() },
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

function crashPod(
  name: string,
  opts: { reason?: string; exitCode?: number; restarts?: number } = {}
) {
  return {
    metadata: { name, creationTimestamp: ago(60_000).toISOString() },
    status: {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [
        {
          name: 'app',
          ready: false,
          restartCount: opts.restarts ?? 4,
          state: {
            waiting: { reason: opts.reason ?? 'CrashLoopBackOff', message: 'back-off 40s' }
          },
          lastState: {
            terminated: { reason: 'Error', exitCode: opts.exitCode ?? 1 }
          }
        }
      ]
    }
  };
}

function startingPod(name: string, created = ago(5_000)) {
  return {
    metadata: { name, creationTimestamp: created.toISOString() },
    status: {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { running: {} } }]
    }
  };
}

function workload(opts: {
  image?: string;
  replicas?: number;
  generation?: number;
  observed?: number;
  updated?: number;
  available?: number;
  total?: number;
  restartedAt?: string;
  conditions?: any[];
}) {
  const replicas = opts.replicas ?? 1;
  return {
    metadata: { generation: opts.generation ?? 3 },
    spec: {
      replicas,
      template: {
        metadata: {
          annotations: opts.restartedAt
            ? { 'kubectl.kubernetes.io/restartedAt': opts.restartedAt }
            : {}
        },
        spec: { containers: [{ name: 'app', image: opts.image ?? 'registry.local/app:v1' }] }
      }
    },
    status: {
      observedGeneration: opts.observed ?? opts.generation ?? 3,
      updatedReplicas: opts.updated ?? replicas,
      availableReplicas: opts.available ?? replicas,
      replicas: opts.total ?? replicas,
      conditions: opts.conditions ?? []
    }
  };
}

type StateOverrides = Omit<Partial<RolloutState>, 'deployment'> & {
  deployment?: Partial<RolloutState['deployment']>;
};

function state(overrides: StateOverrides = {}): RolloutState {
  const { deployment, ...rest } = overrides;
  return {
    deployment: {
      stopped: false,
      replicas: 1,
      image: 'registry.local/app:v1',
      buildStatus: 'succeeded',
      buildStep: 'complete',
      buildError: null,
      updatedAt: ago(3_600_000),
      ...deployment
    },
    activeBuildRun: null,
    lastBuildFinishedAt: ago(3_600_000),
    workload: { manifest: workload({}), syncedAt: ago(3_000_000) },
    pods: [readyPod('app-1')],
    pin: null,
    now: NOW,
    ...rest
  };
}

test('a fully rolled out deployment with ready pods is live and terminal', () => {
  const v = deriveRolloutPhase(state());
  assert.equal(v.phase, 'live');
  assert.equal(v.terminal, true);
  assert.equal(v.desired, 1);
  assert.equal(v.ready, 1);
  assert.equal(v.hint, null);
});

test('a running build reads as building, and its deploy step as deploying', () => {
  const building = deriveRolloutPhase(
    state({ deployment: { buildStatus: 'building', buildStep: 'build' } })
  );
  assert.equal(building.phase, 'building');
  assert.equal(building.terminal, false);

  const deploying = deriveRolloutPhase(
    state({ deployment: { buildStatus: 'building', buildStep: 'deploying' } })
  );
  assert.equal(deploying.phase, 'deploying');
  assert.equal(deploying.terminal, false);
});

test('a build waiting for a slot is queued even though the last build succeeded', () => {
  const v = deriveRolloutPhase(state({ activeBuildRun: { status: 'scheduled' } }));
  assert.equal(v.phase, 'queued');
  assert.equal(v.terminal, false);
  assert.equal(
    deriveRolloutPhase(state({ deployment: { buildStatus: 'pending' } })).phase,
    'queued'
  );
});

test('a failed build is build_failed and terminal', () => {
  const v = deriveRolloutPhase(
    state({ deployment: { buildStatus: 'failed', buildError: 'exit code: 1' } })
  );
  assert.equal(v.phase, 'build_failed');
  assert.equal(v.terminal, true);
  assert.ok(v.hint);
});

test('a blue/green deploy that never became ready is unhealthy, not a build failure', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: {
        buildStatus: 'failed',
        buildError: 'Deploy failed: green never ready. The previous release kept serving.'
      }
    })
  );
  assert.equal(v.phase, 'unhealthy');
  assert.equal(v.terminal, true);
});

test('every pod crash-looping is crashing with the reason and exit code', () => {
  const v = deriveRolloutPhase(state({ pods: [crashPod('app-2', { exitCode: 137 })] }));
  assert.equal(v.phase, 'crashing');
  assert.equal(v.terminal, true);
  assert.equal(v.failing.length, 1);
  assert.deepEqual(v.failing[0], {
    pod: 'app-2',
    container: 'app',
    reason: 'CrashLoopBackOff',
    message: 'back-off 40s',
    exitCode: 137,
    restarts: 4
  });
  assert.match(v.hint ?? '', /exit code 137/);
});

test('new pods failing while old pods keep serving is unhealthy', () => {
  const v = deriveRolloutPhase(
    state({
      workload: {
        manifest: workload({ updated: 0, available: 1, total: 2 }),
        syncedAt: ago(1_000)
      },
      pods: [readyPod('app-old'), crashPod('app-new')]
    })
  );
  assert.equal(v.phase, 'unhealthy');
  assert.equal(v.terminal, true);
  assert.equal(v.ready, 1);
  assert.equal(v.failing[0].pod, 'app-new');
  assert.match(v.hint ?? '', /keep serving/);
});

test('image pull failures get a registry hint', () => {
  const v = deriveRolloutPhase(
    state({ pods: [crashPod('app-1', { reason: 'ImagePullBackOff' })] })
  );
  assert.equal(v.phase, 'crashing');
  assert.match(v.hint ?? '', /could not be pulled/);
});

test('a pod that restarted many times and is not ready counts as failing', () => {
  const pod = startingPod('app-1');
  pod.status.containerStatuses[0].restartCount = 9;
  assert.ok(describeFailingPod(pod));
  assert.equal(describeFailingPod(readyPod('ok')), null);
});

test('stopped or scaled-to-zero deployments are stopped and terminal', () => {
  const stopped = deriveRolloutPhase(state({ deployment: { stopped: true }, pods: [] }));
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.terminal, true);
  const zero = deriveRolloutPhase(state({ deployment: { replicas: 0 }, pods: [] }));
  assert.equal(zero.phase, 'stopped');
});

test('a rollout still replacing pods is deploying', () => {
  const v = deriveRolloutPhase(
    state({
      workload: {
        manifest: workload({ generation: 4, observed: 4, updated: 1, available: 1, total: 2 }),
        syncedAt: ago(1_000)
      },
      pods: [readyPod('app-old'), startingPod('app-new')]
    })
  );
  assert.equal(v.phase, 'deploying');
  assert.equal(v.terminal, false);
  assert.match(v.hint ?? '', /health check/);
});

test('a generation the controller has not observed yet is deploying', () => {
  const v = deriveRolloutPhase(
    state({ workload: { manifest: workload({ generation: 5, observed: 4 }), syncedAt: ago(500) } })
  );
  assert.equal(v.phase, 'deploying');
});

test('a progress deadline is unhealthy', () => {
  const v = deriveRolloutPhase(
    state({
      workload: {
        manifest: workload({
          updated: 0,
          conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }]
        }),
        syncedAt: ago(1_000)
      },
      pods: [readyPod('app-old'), startingPod('app-new')]
    })
  );
  assert.equal(v.phase, 'unhealthy');
  assert.equal(v.terminal, true);
});

test('a new image the mirror has not seen yet keeps the rollout deploying', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: { image: 'registry.local/app:v2', updatedAt: ago(2_000) }
    })
  );
  assert.equal(v.phase, 'deploying');
});

test('a persistent image spelling mismatch stops blocking after the intent grace', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: {
        image: 'registry.local/app:v2',
        updatedAt: ago(INTENT_GRACE_MS + 1_000)
      }
    })
  );
  assert.equal(v.phase, 'live');
});

test('the same image under a different registry host still matches', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: { image: 'registry.local:80/app:v1', updatedAt: ago(1_000) }
    })
  );
  assert.equal(v.phase, 'live');
});

test('a scale the mirror has not applied yet is deploying', () => {
  const v = deriveRolloutPhase(state({ deployment: { replicas: 3, updatedAt: ago(1_000) } }));
  assert.equal(v.phase, 'deploying');
  assert.equal(v.desired, 3);
});

test('an external scale is adopted once the intent grace passes', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: { replicas: 3, updatedAt: ago(INTENT_GRACE_MS + 1_000) }
    })
  );
  assert.equal(v.phase, 'live');
  assert.equal(v.desired, 1);
});

test('a pinned restart cannot read live off the old pods', () => {
  const since = ago(1_000);
  const v = deriveRolloutPhase(
    state({ pin: { since, image: null, releaseStatus: null, releaseReason: null } })
  );
  assert.equal(v.phase, 'deploying');
  assert.equal(v.terminal, false);
});

test('a pinned restart is live once the mirror has seen the restart and it rolled out', () => {
  const since = ago(10_000);
  const v = deriveRolloutPhase(
    state({
      workload: {
        manifest: workload({ generation: 6, restartedAt: ago(9_000).toISOString() }),
        syncedAt: ago(2_000)
      },
      pods: [readyPod('app-new', ago(8_000))],
      pin: { since, image: null, releaseStatus: null, releaseReason: null }
    })
  );
  assert.equal(v.phase, 'live');
});

test('a pin on a no-op change stops blocking after the pin grace', () => {
  const v = deriveRolloutPhase(
    state({
      pin: {
        since: ago(PIN_GRACE_MS + 1_000),
        image: null,
        releaseStatus: null,
        releaseReason: null
      }
    })
  );
  assert.equal(v.phase, 'live');
});

test('a release pin waits for its own image', () => {
  const v = deriveRolloutPhase(
    state({
      workload: { manifest: workload({ image: 'registry.local/app:v1' }), syncedAt: ago(1_000) },
      pin: {
        since: ago(5_000),
        image: 'registry.local/app:v2',
        releaseStatus: 'live',
        releaseReason: null
      }
    })
  );
  assert.equal(v.phase, 'deploying');
});

test('a failed pinned release is unhealthy with its reason', () => {
  const v = deriveRolloutPhase(
    state({
      pin: {
        since: ago(5_000),
        image: 'registry.local/app:v2',
        releaseStatus: 'failed',
        releaseReason: 'green never became ready'
      }
    })
  );
  assert.equal(v.phase, 'unhealthy');
  assert.match(v.hint ?? '', /green never became ready/);
});

test('a build failure older than the pin does not fail a later restart', () => {
  const v = deriveRolloutPhase(
    state({
      deployment: { buildStatus: 'failed', buildError: 'old failure' },
      lastBuildFinishedAt: ago(600_000),
      workload: {
        manifest: workload({ restartedAt: ago(9_000).toISOString() }),
        syncedAt: ago(2_000)
      },
      pods: [readyPod('app-new', ago(8_000))],
      pin: { since: ago(10_000), image: null, releaseStatus: null, releaseReason: null }
    })
  );
  assert.equal(v.phase, 'live');
});

test('without a mirrored workload the pods alone decide', () => {
  assert.equal(deriveRolloutPhase(state({ workload: null })).phase, 'live');
  assert.equal(
    deriveRolloutPhase(state({ workload: null, pods: [startingPod('app-1')] })).phase,
    'deploying'
  );
  assert.equal(deriveRolloutPhase(state({ workload: null, pods: [] })).phase, 'deploying');
});

test('terminating pods do not count against the rollout', () => {
  const leaving = readyPod('app-old') as any;
  leaving.metadata.deletionTimestamp = NOW.toISOString();
  const v = deriveRolloutPhase(state({ workload: null, pods: [readyPod('app-new'), leaving] }));
  assert.equal(v.phase, 'live');
});

test('without build runs a failure is stale only if the row predates the pin', () => {
  const pin = { since: ago(10_000), image: null, releaseStatus: null, releaseReason: null };
  const fresh = deriveRolloutPhase(
    state({
      deployment: { buildStatus: 'failed', buildError: 'boom', updatedAt: ago(1_000) },
      lastBuildFinishedAt: null,
      pin
    })
  );
  assert.equal(fresh.phase, 'build_failed');
  const stale = deriveRolloutPhase(
    state({
      deployment: { buildStatus: 'failed', buildError: 'boom', updatedAt: ago(600_000) },
      lastBuildFinishedAt: null,
      workload: {
        manifest: workload({ restartedAt: ago(9_000).toISOString() }),
        syncedAt: ago(2_000)
      },
      pods: [readyPod('app-new', ago(8_000))],
      pin
    })
  );
  assert.equal(stale.phase, 'live');
});
