import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionsService } from '../src/auth/sessions.service';

test('a busy session writes lastActiveAt once a minute, not once per request', async () => {
  const writes: string[] = [];
  const prisma = {
    session: {
      update: async ({ where }: { where: { id: string } }) => {
        writes.push(where.id);
        return {};
      }
    }
  };
  const sessions = new SessionsService(prisma as any, {} as any, {} as any);
  for (let i = 0; i < 20; i++) await sessions.touchSession('s1');
  await sessions.touchSession('s2');
  assert.deepEqual(writes, ['s1', 's2']);
});
