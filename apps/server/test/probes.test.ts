import assert from 'node:assert/strict';
import test from 'node:test';
import { livenessProbe, probesFor, readinessProbe, startupProbe } from '../src/kubernetes/probes';

const dockerDefaults = {
  type: 'exec',
  command: null,
  execCommand: ['ruby', '-e', 'exit 0'],
  interval: 30,
  timeout: 5,
  retries: 3,
  startupFailureThreshold: 5
};

test('liveness keeps the configured interval, the gating probes run every few seconds', () => {
  assert.equal(livenessProbe(dockerDefaults).periodSeconds, 30);
  assert.equal(readinessProbe(dockerDefaults).periodSeconds, 5);
  assert.equal(startupProbe(dockerDefaults).periodSeconds, 5);
});

test('a faster period keeps the same time budget before a probe gives up', () => {
  assert.equal(livenessProbe(dockerDefaults).failureThreshold, 3);
  assert.equal(readinessProbe(dockerDefaults).failureThreshold, 18);
  assert.equal(startupProbe(dockerDefaults).failureThreshold, 30);
});

test('an interval already shorter than the fast period is left alone', () => {
  const quick = { ...dockerDefaults, interval: 2 };
  assert.equal(readinessProbe(quick).periodSeconds, 2);
  assert.equal(readinessProbe(quick).failureThreshold, 3);
  assert.equal(startupProbe(quick).failureThreshold, 5);
});

test('every probe carries the same handler', () => {
  const http = { ...dockerDefaults, type: 'http', path: '/up', port: 3000 };
  for (const probe of [livenessProbe(http), readinessProbe(http), startupProbe(http)]) {
    assert.deepEqual(probe.httpGet, { path: '/up', port: 3000 });
    assert.equal(probe.exec, undefined);
  }
  assert.deepEqual(startupProbe(dockerDefaults).exec, { command: ['ruby', '-e', 'exit 0'] });
  assert.deepEqual(readinessProbe({ ...dockerDefaults, type: 'tcp', port: 8080 }).tcpSocket, {
    port: 8080
  });
});

test('probesFor honours the per-probe toggles and the master switch', () => {
  const toggles = { livenessEnabled: true, readinessEnabled: true, startupEnabled: false };
  const on = probesFor({ ...dockerDefaults, ...toggles, enabled: true });
  assert.ok(on.liveness);
  assert.ok(on.readiness);
  assert.equal(on.startup, null);
  const off = probesFor({ ...dockerDefaults, ...toggles, enabled: false });
  assert.deepEqual(off, { liveness: null, readiness: null, startup: null });
});
