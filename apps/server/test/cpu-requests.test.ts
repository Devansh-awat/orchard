import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuRequestFromLimitMilli,
  cpuMilliToK8s,
  cpuLimitMilliFromResources,
  memoryLimitBytesFromResources
} from '../src/kubernetes/quantity';

function render(limitMilli: number) {
  return {
    limits: { cpu: cpuMilliToK8s(limitMilli), memory: '1Gi' },
    requests: { cpu: cpuMilliToK8s(cpuRequestFromLimitMilli(limitMilli)), memory: '1Gi' }
  };
}

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

test('reading back a rendered spec recovers the limit, not the derived request', () => {
  withEnv(DEFAULTS, () => {
    for (const limit of [50, 100, 200, 250, 500, 750, 1000, 1500, 4000]) {
      assert.equal(cpuLimitMilliFromResources(render(limit)), limit, `limit=${limit}`);
      assert.equal(memoryLimitBytesFromResources(render(limit)), 1024 ** 3);
    }
  });
});

test('repeated render/read-back passes never shrink the workload', () => {
  withEnv(DEFAULTS, () => {
    let stored = 1500;
    for (let pass = 0; pass < 5; pass += 1) stored = cpuLimitMilliFromResources(render(stored));
    assert.equal(stored, 1500);
  });
});

test('reads the request only when a spec carries no limit', () => {
  assert.equal(cpuLimitMilliFromResources({ requests: { cpu: '250m' } }), 250);
  assert.equal(memoryLimitBytesFromResources({ requests: { memory: '512Mi' } }), 512 * 1024 ** 2);
  assert.equal(cpuLimitMilliFromResources({}), 0);
  assert.equal(cpuLimitMilliFromResources(undefined), 0);
  assert.equal(memoryLimitBytesFromResources(null), 0);
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
