import test from 'node:test';
import assert from 'node:assert/strict';
import { planEnvAdoption } from '../src/env/env-adoption';
import { ENV_HASH_ANNOTATION, envHash, envObservationKey } from '../src/kubernetes/env-patch';
import { WorkloadConsumer } from '../src/engine/consumers/workload.consumer';

const NAME = 'web';
const secretRef = (key: string) => ({
  name: key,
  valueFrom: { secretKeyRef: { name: `${NAME}-env`, key } }
});

const plan = (live: any[], own: any[], resolved = own) =>
  planEnvAdoption({ deploymentName: NAME, live, own, resolved });

test('a literal changed with kubectl is adopted', () => {
  const p = plan(
    [{ name: 'MODE', value: 'fast' }],
    [{ key: 'MODE', value: 'slow', secret: false }]
  );
  assert.deepEqual(p.upserts, [{ key: 'MODE', value: 'fast', secret: false }]);
  assert.deepEqual(p.removals, []);
  assert.deepEqual(p.conflicts, []);
});

test('a variable added with kubectl becomes an Orchard variable', () => {
  const p = plan([{ name: 'NEW', value: '1' }], []);
  assert.deepEqual(p.upserts, [{ key: 'NEW', value: '1', secret: false }]);
});

test('a variable unset with kubectl is removed', () => {
  const p = plan([], [{ key: 'GONE', value: 'x', secret: false }]);
  assert.deepEqual(p.removals, ['GONE']);
});

test('a value built from a reference cannot be adopted and is reported', () => {
  const own = [{ key: 'DB', value: '${{shared.DATABASE_URL}}', secret: false }];
  const resolved = [{ key: 'DB', value: 'postgres://a', secret: false }];
  const changed = plan([{ name: 'DB', value: 'postgres://b' }], own, resolved);
  assert.deepEqual(changed.upserts, []);
  assert.deepEqual(changed.conflicts, [{ key: 'DB', reason: 'reference' }]);

  const same = plan([{ name: 'DB', value: 'postgres://a' }], own, resolved);
  assert.deepEqual(same, { upserts: [], removals: [], conflicts: [] });
});

test('secrets stay in the secret unless kubectl inlined a new value', () => {
  const own = [{ key: 'TOKEN', value: 'abc', secret: true }];
  assert.deepEqual(plan([secretRef('TOKEN')], own), { upserts: [], removals: [], conflicts: [] });
  const inlined = plan([{ name: 'TOKEN', value: 'xyz' }], own);
  assert.deepEqual(inlined.upserts, [{ key: 'TOKEN', value: 'xyz', secret: true }]);
});

test('env read from a source Orchard does not manage is reported, not adopted', () => {
  const p = plan([{ name: 'CFG', valueFrom: { configMapKeyRef: { name: 'cm', key: 'cfg' } } }], []);
  assert.deepEqual(p.upserts, []);
  assert.deepEqual(p.conflicts, [{ key: 'CFG', reason: 'foreign-source' }]);
});

test('injected and pull-auth keys are never adopted', () => {
  const p = plan(
    [
      { name: 'HOST', value: '0.0.0.0' },
      { name: 'FORCE_COLOR', value: '1' },
      { name: 'DOCKER_AUTH_CONFIG', value: '{}' }
    ],
    []
  );
  assert.deepEqual(p, { upserts: [], removals: [], conflicts: [] });
});

test('the env hash ignores order and notices a changed value', () => {
  const a = [
    { name: 'A', value: '1' },
    { name: 'B', value: '2' }
  ];
  const b = [
    { name: 'B', value: '2' },
    { name: 'A', value: '1' }
  ];
  assert.equal(envHash(a), envHash(b));
  assert.notEqual(
    envHash(a),
    envHash([
      { name: 'A', value: '1' },
      { name: 'B', value: '3' }
    ])
  );
});

function consumerHarness(opts: { observed?: string | null; recentEnvWrites?: number }) {
  const calls: { live: any[]; observation: string }[] = [];
  const prisma = {
    deploymentEnvVar: { count: async () => opts.recentEnvWrites ?? 0 }
  };
  const moduleRef = {
    get: () => ({
      adoptClusterEnv: async (_id: string, live: any[], observation: string) => {
        calls.push({ live, observation });
        return { upserts: [], removals: [], conflicts: [] };
      }
    })
  };
  const consumer = new WorkloadConsumer(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    moduleRef as any
  );
  const adopt = (dep: any) =>
    (consumer as any).adoptEnv('d1', NAME, opts.observed ?? null, dep) as Promise<void>;
  return { adopt, calls };
}

const deploymentWith = (env: any[], written?: string) => ({
  metadata: { annotations: written ? { [ENV_HASH_ANNOTATION]: written } : {} },
  spec: { template: { spec: { containers: [{ name: NAME, env }] } } }
});

test('env Orchard wrote itself is never adopted back', async () => {
  const env = [{ name: 'A', value: '1' }];
  const { adopt, calls } = consumerHarness({});
  await adopt(deploymentWith(env, envHash(env)));
  await adopt(deploymentWith(env));
  assert.equal(calls.length, 0);
});

test('an outside edit is adopted once, then recognised', async () => {
  const written = envHash([{ name: 'A', value: '1' }]);
  const edited = [{ name: 'A', value: '2' }];
  const first = consumerHarness({});
  await first.adopt(deploymentWith(edited, written));
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].observation, envObservationKey(written, envHash(edited)));

  const again = consumerHarness({ observed: first.calls[0].observation });
  await again.adopt(deploymentWith(edited, written));
  assert.equal(again.calls.length, 0);

  const rewritten = envHash([{ name: 'A', value: '3' }]);
  const afterOrchardWrite = consumerHarness({ observed: first.calls[0].observation });
  await afterOrchardWrite.adopt(deploymentWith(edited, rewritten));
  assert.equal(
    afterOrchardWrite.calls.length,
    1,
    'an Orchard write invalidates the old observation'
  );
});

test('an Orchard env save moments ago holds adoption back', async () => {
  const { adopt, calls } = consumerHarness({ recentEnvWrites: 1 });
  await assert.rejects(adopt(deploymentWith([{ name: 'A', value: '2' }], 'stale-hash')));
  assert.equal(calls.length, 0);
});
