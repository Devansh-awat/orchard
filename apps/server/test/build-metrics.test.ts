import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCacheStats,
  cacheClass,
  phaseDurations,
  pipelineOutcome
} from '../src/analytics/build-metrics';

const dockerfileLog = [
  '#a1b2c3d4 [internal] load build definition from Dockerfile',
  '#a1b2c3d4 DONE 0.0s',
  '#00000001 [base 1/4] FROM docker.io/library/node:22-slim',
  '#00000001 CACHED',
  '#00000002 [base 2/4] RUN corepack enable',
  '#00000002 CACHED',
  '#00000003 [deps 1/2] RUN pnpm install --frozen-lockfile',
  '#00000003 1.234 Progress: resolved 10',
  '#00000003 DONE 12.3s',
  '#00000004 [build 1/1] COPY . .',
  '#00000004 DONE 0.4s',
  '#00000005 exporting to image',
  '#00000005 DONE 3.0s'
].join('\n');

test('cache stats count real steps and skip buildkit internals and base image pulls', () => {
  assert.deepEqual(buildCacheStats(dockerfileLog), { steps: 3, cached: 1 });
  assert.equal(cacheClass(buildCacheStats(dockerfileLog)), 'partial');
});

test('plain buildkit output with numeric ids parses the same', () => {
  const plain = ['#5 [2/3] RUN make', '#5 CACHED', '#6 [3/3] COPY . .', '#6 CACHED'].join('\n');
  assert.deepEqual(buildCacheStats(plain), { steps: 2, cached: 2 });
  assert.equal(cacheClass(buildCacheStats(plain)), 'full');
});

test('railpack frontends and secrets hashing are not counted as steps', () => {
  const railpack = [
    '#0a0a0a0a docker-image://ghcr.io/railwayapp/railpack-frontend:v0.33.0',
    '#0a0a0a0a DONE 0.1s',
    '#0b0b0b0b [railpack] secrets hash',
    '#0b0b0b0b DONE 0.0s',
    '#0c0c0c0c pnpm install --frozen-lockfile',
    '#0c0c0c0c DONE 20.0s',
    '#0d0d0d0d copy /railpack/caddy',
    '#0d0d0d0d CACHED'
  ].join('\n');
  assert.deepEqual(buildCacheStats(railpack), { steps: 2, cached: 1 });
});

test('no steps means the cache state is unknown', () => {
  assert.equal(cacheClass(buildCacheStats('')), 'unknown');
  assert.equal(cacheClass(buildCacheStats(null)), 'unknown');
  assert.equal(cacheClass({ steps: 4, cached: 0 }), 'none');
});

test('phases come from the step timestamps and skip anything missing or backwards', () => {
  const { phases, totalMs } = phaseDurations(
    {
      __start: 1000,
      cloning: 1500,
      building: 4000,
      pushing: 9000,
      deploying: 9500,
      complete: 12000
    },
    99999
  );
  assert.deepEqual(phases, { queue: 500, setup: 2500, build: 5000, push: 500, rollout: 2500 });
  assert.equal(totalMs, 11000);
  const failed = phaseDurations({ __start: 1000, cloning: 900, building: 3000 }, 5000);
  assert.deepEqual(failed.phases, { setup: 2100 });
  assert.equal(failed.totalMs, 4000);
  assert.equal(phaseDurations(null, 5000).totalMs, null);
});

test('cancelled builds are not failures', () => {
  assert.equal(pipelineOutcome(true), 'succeeded');
  assert.equal(pipelineOutcome(false, 'Build failed: build cancelled'), 'cancelled');
  assert.equal(pipelineOutcome(false, 'Build failed: exit code 1'), 'failed');
});
