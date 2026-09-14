import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDockerfileHealthCheck as parse } from '../src/github/dockerfile-healthcheck';
import { resolveHealthCheck, StoredHealthCheck } from '../src/projects/health-check-resolve';

/**
 * A repo that already declares how to probe itself should not have to say it
 * again in Orchard's settings. These pin the two halves of that: what counts
 * as the image's HEALTHCHECK, and which config a deployment actually runs.
 */

const STORED: StoredHealthCheck = {
  healthCheckEnabled: false,
  healthCheckType: 'http',
  healthCheckPath: '/healthz',
  healthCheckPort: 8080,
  healthCheckCommand: null,
  livenessEnabled: true,
  readinessEnabled: true,
  startupEnabled: false,
  healthCheckInterval: 30,
  healthCheckTimeout: 5,
  healthCheckRetries: 3,
  startupFailureThreshold: 30,
  healthCheckOverride: false,
  dockerfileHealthCheck: null,
};

test('a shell-form HEALTHCHECK keeps its operators by running under sh -c', () => {
  const hc = parse(
    'FROM node:20\nHEALTHCHECK --interval=10s --timeout=2s --retries=5 CMD curl -f http://localhost:3000/health || exit 1\n',
  );
  assert.deepEqual(hc?.command, [
    '/bin/sh',
    '-c',
    'curl -f http://localhost:3000/health || exit 1',
  ]);
  assert.equal(hc?.interval, 10);
  assert.equal(hc?.timeout, 2);
  assert.equal(hc?.retries, 5);
});

test('an exec-form HEALTHCHECK is taken as argv', () => {
  const hc = parse('FROM alpine\nHEALTHCHECK CMD ["/app/health", "--quiet"]\n');
  assert.deepEqual(hc?.command, ['/app/health', '--quiet']);
});

test('a line continuation is read as one instruction', () => {
  const hc = parse(
    'FROM alpine\nHEALTHCHECK --interval=1m \\\n  --start-period=45s \\\n  CMD wget -q -O /dev/null http://localhost/\n',
  );
  assert.deepEqual(hc?.command, ['/bin/sh', '-c', 'wget -q -O /dev/null http://localhost/']);
  assert.equal(hc?.interval, 60);
  assert.equal(hc?.startPeriod, 45);
});

test('a comment inside a continuation does not swallow the instruction', () => {
  const hc = parse(
    'FROM alpine\nHEALTHCHECK --interval=30s \\\n  # keep this cheap\n\n  CMD curl -f http://localhost/ || exit 1\n',
  );
  assert.deepEqual(hc?.command, ['/bin/sh', '-c', 'curl -f http://localhost/ || exit 1']);
  assert.equal(hc?.interval, 30);
});

test('a builder stage HEALTHCHECK never reaches the built image', () => {
  const hc = parse(
    'FROM golang AS build\nHEALTHCHECK CMD /build/check\nFROM alpine\nCOPY --from=build /out /app\n',
  );
  assert.equal(hc, null);
});

test('a HEALTHCHECK is inherited from the stage the final image is built on', () => {
  const hc = parse(
    'FROM alpine AS base\nHEALTHCHECK CMD /base/check\nFROM base AS runtime\nCMD ["/app"]\n',
  );
  assert.deepEqual(hc?.command, ['/bin/sh', '-c', '/base/check']);
});

test('HEALTHCHECK NONE withdraws an inherited check', () => {
  const hc = parse(
    'FROM alpine AS base\nHEALTHCHECK CMD /base/check\nFROM base\nHEALTHCHECK NONE\n',
  );
  assert.equal(hc, null);
});

test('a target stage is read instead of the last one', () => {
  const dockerfile =
    'FROM alpine AS dev\nHEALTHCHECK CMD /dev/check\nFROM alpine AS prod\nHEALTHCHECK CMD /prod/check\n';
  assert.deepEqual(parse(dockerfile, 'dev')?.command, ['/bin/sh', '-c', '/dev/check']);
  assert.deepEqual(parse(dockerfile, 'prod')?.command, ['/bin/sh', '-c', '/prod/check']);
});

test('a commented-out HEALTHCHECK is not one', () => {
  assert.equal(parse('FROM alpine\n# HEALTHCHECK CMD /check\n'), null);
});

test('a Dockerfile HEALTHCHECK runs even when Orchard has no health check configured', () => {
  const resolved = resolveHealthCheck({
    ...STORED,
    dockerfileHealthCheck: { command: ['/bin/sh', '-c', 'curl -f localhost || exit 1'] },
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.source, 'dockerfile');
  assert.equal(resolved.type, 'exec');
  assert.deepEqual(resolved.execCommand, ['/bin/sh', '-c', 'curl -f localhost || exit 1']);
  assert.equal(resolved.interval, 30);
});

test('a start period becomes a startup probe long enough to cover it', () => {
  const resolved = resolveHealthCheck({
    ...STORED,
    dockerfileHealthCheck: {
      command: ['/check'],
      interval: 10,
      retries: 2,
      startPeriod: 60,
    },
  });
  assert.equal(resolved.startupEnabled, true);
  assert.equal(resolved.startupFailureThreshold, 8);
});

test('a check may not take longer than the gap between checks', () => {
  const resolved = resolveHealthCheck({
    ...STORED,
    dockerfileHealthCheck: { command: ['/check'], interval: 5 },
  });
  assert.equal(resolved.timeout, 5);
});

test('the override flag hands the deployment back to its own settings', () => {
  const resolved = resolveHealthCheck({
    ...STORED,
    healthCheckEnabled: true,
    healthCheckOverride: true,
    dockerfileHealthCheck: { command: ['/check'] },
  });
  assert.equal(resolved.source, 'manual');
  assert.equal(resolved.type, 'http');
  assert.equal(resolved.path, '/healthz');
  assert.equal(resolved.port, 8080);
});

test('a malformed stored detection is ignored rather than probed with', () => {
  const resolved = resolveHealthCheck({ ...STORED, dockerfileHealthCheck: { command: [] } });
  assert.equal(resolved.source, 'manual');
  assert.equal(resolved.enabled, false);
});
