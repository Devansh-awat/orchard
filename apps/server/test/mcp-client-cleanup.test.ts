import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_CLIENT_BATCH,
  MCP_CLIENT_TRACKING_SINCE,
  MCP_IDLE_CLIENT_TTL_MS,
  MCP_UNUSED_CLIENT_TTL_MS,
  McpClientCleanupService
} from '../src/auth/mcp-client-cleanup.service';
import { GLOBAL_LEADER_LEASE } from '../src/coordination/lease.service';

interface Row {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function matches(row: Row, where: any): boolean {
  return where.OR.some((clause: any) => {
    if (clause.lastUsedAt === null) {
      return (
        row.lastUsedAt === null &&
        row.createdAt >= clause.createdAt.gte &&
        row.createdAt < clause.createdAt.lt
      );
    }
    return row.lastUsedAt !== null && row.lastUsedAt < clause.lastUsedAt.lt;
  });
}

function harness(rows: Row[], canCoordinate = true, holder = true) {
  let table = [...rows];
  const sizes: number[] = [];
  const prisma: any = {
    mcpOauthClient: {
      findMany: async ({ where, take }: any) =>
        table.filter((r) => matches(r, where)).slice(0, take),
      deleteMany: async ({ where }: any) => {
        const ids = new Set(where.id.in);
        sizes.push(ids.size);
        const before = table.length;
        table = table.filter((r) => !ids.has(r.id));
        return { count: before - table.length };
      }
    }
  };
  const service = new McpClientCleanupService(
    { canCoordinate, isHolder: (name: string) => holder && name === GLOBAL_LEADER_LEASE } as any,
    prisma
  );
  return { service, ids: () => table.map((r) => r.id), sizes };
}

const NOW = MCP_CLIENT_TRACKING_SINCE.getTime() + 200 * 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms);
const DAY = 24 * 60 * 60 * 1000;

test('never-used clients go after a week and idle ones after ninety days', async () => {
  const { service, ids } = harness([
    { id: 'fresh-unused', createdAt: ago(DAY), lastUsedAt: null },
    { id: 'old-unused', createdAt: ago(MCP_UNUSED_CLIENT_TTL_MS + DAY), lastUsedAt: null },
    { id: 'active', createdAt: ago(300 * DAY), lastUsedAt: ago(DAY) },
    { id: 'idle', createdAt: ago(300 * DAY), lastUsedAt: ago(MCP_IDLE_CLIENT_TTL_MS + DAY) },
    { id: 'recent-old-use', createdAt: ago(300 * DAY), lastUsedAt: ago(30 * DAY) }
  ]);
  const removed = await service.cleanup(NOW);
  assert.equal(removed, 2);
  assert.deepEqual(ids().sort(), ['active', 'fresh-unused', 'recent-old-use']);
});

test('clients registered before usage tracking existed are never judged unused', async () => {
  const legacy = new Date(MCP_CLIENT_TRACKING_SINCE.getTime() - 400 * DAY);
  const { service, ids } = harness([{ id: 'legacy', createdAt: legacy, lastUsedAt: null }]);
  assert.equal(await service.cleanup(NOW), 0);
  assert.deepEqual(ids(), ['legacy']);
});

test('deletes are batched', async () => {
  const rows = Array.from({ length: MCP_CLIENT_BATCH * 2 + 3 }, (_, i) => ({
    id: String(i),
    createdAt: ago(MCP_UNUSED_CLIENT_TTL_MS + DAY),
    lastUsedAt: null
  }));
  const { service, sizes, ids } = harness(rows);
  assert.equal(await service.cleanup(NOW), rows.length);
  assert.ok(sizes.every((n) => n <= MCP_CLIENT_BATCH));
  assert.equal(ids().length, 0);
});

test('only the coordinating lease holder runs the job', async () => {
  const stale = [
    { id: 'x', createdAt: ago(MCP_UNUSED_CLIENT_TTL_MS + DAY), lastUsedAt: null as Date | null }
  ];
  const a = harness(stale, false, true);
  await a.service.tick();
  assert.deepEqual(a.ids(), ['x']);
  const b = harness(stale, true, false);
  await b.service.tick();
  assert.deepEqual(b.ids(), ['x']);
});
