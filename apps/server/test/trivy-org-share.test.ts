import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanQueueFullError, TrivyScanService } from '../src/security/trivy-scan.service';

function service(opts: { running: Array<{ requestedBy: string | null }>; members: string[] }) {
  const created: unknown[] = [];
  const trivy = Object.create(TrivyScanService.prototype) as any;
  trivy.timeoutSeconds = 900;
  trivy.maxRunning = 3;
  trivy.maxRunningPerOrg = 1;
  trivy.prisma = {
    deployment: {
      findUnique: async () => ({ project: { organizationId: 'orgA' } })
    },
    imageScan: {
      findFirst: async () => null,
      count: async () => opts.running.length,
      findMany: async () => opts.running,
      create: async () => {
        created.push(1);
        throw new Error('stop');
      }
    },
    organizationMember: {
      findMany: async ({ where }: any) =>
        opts.members.filter((id) => where.userId.in.includes(id)).map((userId) => ({ userId }))
    }
  };
  return { trivy: trivy as TrivyScanService, created };
}

test('an organization with a scan already running cannot start another', async () => {
  const { trivy, created } = service({
    running: [{ requestedBy: 'alice' }],
    members: ['alice', 'bob']
  });
  await assert.rejects(
    trivy.start('registry/app:1', { deploymentId: 'd1', userId: 'bob' }),
    ScanQueueFullError
  );
  assert.equal(created.length, 0);
});

test('another organization is not blocked by a scan it does not own', async () => {
  const { trivy, created } = service({
    running: [{ requestedBy: 'mallory' }, { requestedBy: 'mallory' }],
    members: ['alice', 'bob']
  });
  await assert.rejects(
    trivy.start('registry/app:1', { deploymentId: 'd1', userId: 'bob' }),
    /stop/
  );
  assert.equal(created.length, 1);
});

test('the global cap still applies on top of the per-org share', async () => {
  const { trivy } = service({
    running: [{ requestedBy: 'm1' }, { requestedBy: 'm2' }, { requestedBy: 'm3' }],
    members: ['alice']
  });
  await assert.rejects(
    trivy.start('registry/app:1', { deploymentId: 'd1', userId: 'alice' }),
    ScanQueueFullError
  );
});
