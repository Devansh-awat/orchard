import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { KubernetesController } from '../src/kubernetes/kubernetes.controller';

const USER_ID = '11111111-1111-1111-8111-111111111111';
const req = { user: { sub: USER_ID } };

function makeController() {
  const calls: any[][] = [];
  const prisma = {
    project: { findFirst: async () => ({ id: 'proj-1' }) },
    user: { findFirst: async () => ({ id: USER_ID }) },
  };
  const authz = {
    requireProjectEdit: async () => {},
    requireProjectView: async () => {},
  };
  const workload = {
    getPodLogs: async (...args: any[]) => {
      calls.push(args);
      return { logs: '' };
    },
  };
  const controller = new KubernetesController(
    {} as any,
    {} as any,
    workload as any,
    {} as any,
    authz as any,
    prisma as any,
  );
  return { controller, calls };
}

test('getPodLogs passes sinceSeconds through as a parsed integer', async () => {
  const { controller, calls } = makeController();
  await controller.getPodLogs('pod-1', req, 'ns-1', undefined, undefined, undefined, '30', undefined);
  assert.deepEqual(calls, [['pod-1', 'ns-1', undefined, 100, false, 30, undefined]]);
});

test('getPodLogs passes sinceTime through untouched', async () => {
  const { controller, calls } = makeController();
  await controller.getPodLogs('pod-1', req, 'ns-1', 'web', '50', undefined, undefined, '2026-07-13T00:00:00Z');
  assert.deepEqual(calls, [['pod-1', 'ns-1', 'web', 50, false, undefined, '2026-07-13T00:00:00Z']]);
});

test('getPodLogs accepts fractional-second and offset sinceTime forms', async () => {
  const { controller, calls } = makeController();
  await controller.getPodLogs('pod-1', req, 'ns-1', undefined, undefined, undefined, undefined, '2026-07-13T00:00:00.123456+02:00');
  assert.equal(calls[0][6], '2026-07-13T00:00:00.123456+02:00');
});

test('getPodLogs omits both since params by default', async () => {
  const { controller, calls } = makeController();
  await controller.getPodLogs('pod-1', req, 'ns-1');
  assert.deepEqual(calls, [['pod-1', 'ns-1', undefined, 100, false, undefined, undefined]]);
});

test('getPodLogs rejects sinceSeconds combined with sinceTime', async () => {
  const { controller, calls } = makeController();
  await assert.rejects(
    () => controller.getPodLogs('pod-1', req, 'ns-1', undefined, undefined, undefined, '30', '2026-07-13T00:00:00Z'),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test('getPodLogs rejects non-positive or non-numeric sinceSeconds', async () => {
  const { controller, calls } = makeController();
  for (const bad of ['abc', '-5', '0']) {
    await assert.rejects(
      () => controller.getPodLogs('pod-1', req, 'ns-1', undefined, undefined, undefined, bad, undefined),
      BadRequestException,
    );
  }
  assert.equal(calls.length, 0);
});

test('getPodLogs rejects non-RFC3339 sinceTime', async () => {
  const { controller, calls } = makeController();
  for (const bad of ['not-a-time', '2026-07-13 00:00:00', '2026-07-13T00:00:00', '2026-13-45T00:00:00Z']) {
    await assert.rejects(
      () => controller.getPodLogs('pod-1', req, 'ns-1', undefined, undefined, undefined, undefined, bad),
      BadRequestException,
    );
  }
  assert.equal(calls.length, 0);
});
