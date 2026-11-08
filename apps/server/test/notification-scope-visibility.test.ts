import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { UserNotificationsService } from '../src/notifications/user-notifications.service';
import type { ResolvedScope } from '../src/notifications/notification-scope';

const PROJECT: ResolvedScope = {
  scopeType: 'project',
  scopeId: 'p1',
  projectId: 'p1',
  label: 'Secret project'
};
const ORG: ResolvedScope = {
  scopeType: 'org',
  scopeId: null,
  projectId: null,
  label: 'organization'
};

function service(canView: boolean) {
  const calls: string[] = [];
  const rules = {
    resolveScope: async (_org: string, type: string) => (type === 'org' ? ORG : PROJECT)
  };
  const authz = {
    resolveProjectAccess: async () => {
      calls.push('access');
      return canView ? { canView: true } : null;
    }
  };
  const prisma = {
    userNotificationSetting: {
      findMany: async () => [],
      upsert: async () => ({}),
      deleteMany: async () => ({ count: 0 })
    }
  };
  const svc = new UserNotificationsService(
    prisma as never,
    {} as never,
    rules as never,
    authz as never
  );
  return { svc, calls };
}

test('reading the settings of a project the member cannot see answers like a missing project', async () => {
  const { svc } = service(false);
  await assert.rejects(svc.getScopeSettings('u1', 'o1', 'project', 'p1'), NotFoundException);
});

test('writing the settings of a project the member cannot see answers like a missing project', async () => {
  const { svc } = service(false);
  await assert.rejects(
    svc.setSettings('u1', 'project', 'p1', { values: {} }, 'o1'),
    (error) => error instanceof NotFoundException && error.message === 'Project not found'
  );
});

test('a member who can see the project gets its scope and its label', async () => {
  const { svc } = service(true);
  const result = await svc.getScopeSettings('u1', 'o1', 'project', 'p1');
  assert.equal(result.scope.label, 'Secret project');
});

test('org scope needs no project access check', async () => {
  const { svc, calls } = service(false);
  await svc.getScopeSettings('u1', 'o1', 'org', 'o1');
  assert.deepEqual(calls, []);
});
