import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuRequestFromLimitMilli, cpuMilliToK8s } from '../src/kubernetes/quantity';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const DEFAULTS = { CPU_REQUEST_RATIO: undefined, CPU_REQUEST_MIN_MILLI: undefined };

test('reserves a tenth of the limit by default', () => {
  withEnv(DEFAULTS, () => {
    assert.equal(cpuRequestFromLimitMilli(4000), 400);
    assert.equal(cpuRequestFromLimitMilli(2000), 200);
    assert.equal(cpuRequestFromLimitMilli(1000), 100);
  });
});

test('small workloads get the floor, never more than their limit', () => {
  withEnv(DEFAULTS, () => {
    // 10% of 250m is 25m, below the 50m floor.
    assert.equal(cpuRequestFromLimitMilli(250), 50);
    // A limit under the floor can't be exceeded by its own request — that
    // would be rejected by the apiserver.
    assert.equal(cpuRequestFromLimitMilli(25), 25);
    assert.equal(cpuRequestFromLimitMilli(50), 50);
  });
});

test('ratio and floor are configurable', () => {
  withEnv({ CPU_REQUEST_RATIO: '0.5', CPU_REQUEST_MIN_MILLI: '100' }, () => {
    assert.equal(cpuRequestFromLimitMilli(4000), 2000);
    assert.equal(cpuRequestFromLimitMilli(150), 100);
  });
});

test('ratio of 1 restores requests == limits', () => {
  withEnv({ CPU_REQUEST_RATIO: '1', CPU_REQUEST_MIN_MILLI: undefined }, () => {
    assert.equal(cpuRequestFromLimitMilli(4000), 4000);
    assert.equal(cpuRequestFromLimitMilli(100), 100);
  });
});

test('nonsense config falls back to the defaults rather than throwing', () => {
  for (const ratio of ['0', '-1', '2', 'abc', '']) {
    withEnv({ CPU_REQUEST_RATIO: ratio, CPU_REQUEST_MIN_MILLI: undefined }, () => {
      assert.equal(cpuRequestFromLimitMilli(4000), 400, `ratio=${JSON.stringify(ratio)}`);
    });
  }
  for (const floor of ['0', '-5', 'abc', '']) {
    withEnv({ CPU_REQUEST_RATIO: undefined, CPU_REQUEST_MIN_MILLI: floor }, () => {
      assert.equal(cpuRequestFromLimitMilli(250), 50, `floor=${JSON.stringify(floor)}`);
    });
  }
});

test('always emits a quantity the apiserver accepts', () => {
  withEnv(DEFAULTS, () => {
    for (const limit of [0, 1, 25, 250, 1000, 4000, 64000]) {
      const request = cpuRequestFromLimitMilli(limit);
      assert.ok(request <= Math.max(limit, 0), `request ${request} exceeds limit ${limit}`);
      assert.match(cpuMilliToK8s(request), /^\d+m$/);
    }
  });
});
