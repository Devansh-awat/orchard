import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';
import { hashApiToken } from '../src/auth/api-tokens.service';

const TOKEN = 'orch_' + 'a'.repeat(64);

function serviceWith(row: { userId: string; expiresAt: Date | null } | null) {
  const lookups: string[] = [];
  const prisma = {
    apiToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        lookups.push(where.tokenHash);
        return row;
      }
    }
  };
  return { svc: new McpOAuthService({} as any, prisma as any), lookups };
}

test('a valid API token authenticates on the MCP endpoint', async () => {
  const { svc, lookups } = serviceWith({ userId: 'user-1', expiresAt: null });
  const result = await svc.validateApiToken(`Bearer ${TOKEN}`);
  assert.deepEqual(result, { token: TOKEN, sub: 'user-1', scope: 'read' });
  assert.deepEqual(lookups, [hashApiToken(TOKEN)]);
});

test('an unknown API token is rejected', async () => {
  const { svc } = serviceWith(null);
  assert.equal(await svc.validateApiToken(`Bearer ${TOKEN}`), null);
});

test('an expired API token is rejected', async () => {
  const { svc } = serviceWith({ userId: 'user-1', expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await svc.validateApiToken(`Bearer ${TOKEN}`), null);
});

test('non-API bearers never hit the database', async () => {
  const { svc, lookups } = serviceWith({ userId: 'user-1', expiresAt: null });
  assert.equal(await svc.validateApiToken('Bearer eyJhbGciOiJIUzI1NiJ9.x.y'), null);
  assert.equal(await svc.validateApiToken(undefined), null);
  assert.deepEqual(lookups, []);
});
