import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEPLOYMENT_POD,
  assemblePeaks,
  peakKey,
  peakQueries,
  peakStep
} from '../src/metrics/usage-peaks';

test('usage peaks ask the whole cluster once per metric, keyed by namespace and app', () => {
  const q = peakQueries(86_400);
  for (const query of [...Object.values(q.apps), ...Object.values(q.databases)]) {
    assert.match(query, /^label_join\(/);
    assert.match(query, /"orchard_key", "\/", "namespace", "orchard_app"/);
    assert.match(query, /\[86400s:\d+s\]/);
  }
  assert.ok(q.apps.cpuP95.includes(DEPLOYMENT_POD));
  assert.ok(q.databases.memoryP95.includes('(.+)-[0-9]+'));
});

test('long ranges sample more coarsely so a 30 day view stays cheap', () => {
  assert.equal(peakStep(86_400), 60);
  assert.equal(peakStep(7 * 86_400), 420);
  assert.equal(peakStep(30 * 86_400), 1800);
});

test('the deployment pod pattern resolves the app the way the per-app regex did', () => {
  const app = (pod: string) => new RegExp(`^${DEPLOYMENT_POD}$`).exec(pod)?.[1] ?? null;
  assert.equal(app('web-7d9f8c6b5-x2k4p'), 'web');
  assert.equal(app('web-api-7d9f8c6b5-x2k4p'), 'web-api');
  assert.equal(app('web--green-7d9f8c6b5-x2k4p'), 'web');
  assert.equal(app('postgres-1'), null);
});

test('assembled peaks drop pods that matched no app and keep missing metrics as null', () => {
  const peaks = assemblePeaks(
    86_400,
    1,
    {
      cpuP95: new Map([
        ['ns/web', 120],
        ['ns/', 5]
      ]),
      memoryP95: new Map([['ns/web', 1024]]),
      cpuPodP95: new Map(),
      cpuPodP99: new Map(),
      memoryPodPeak: new Map([['ns/worker', 2048]])
    },
    { cpuP95: new Map([['db/pg-main', 40]]), memoryP95: new Map() }
  );
  assert.deepEqual(peaks.apps[peakKey('ns', 'web')], {
    cpuP95: 120,
    memoryP95: 1024,
    cpuPodP95: null,
    cpuPodP99: null,
    memoryPodPeak: null
  });
  assert.equal(peaks.apps['ns/'], undefined);
  assert.equal(peaks.apps['ns/worker'].memoryPodPeak, 2048);
  assert.deepEqual(peaks.databases['db/pg-main'], { cpuP95: 40, memoryP95: null });
});
