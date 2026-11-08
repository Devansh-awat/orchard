import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpOAuthService,
  MAX_CACHED_CLIENTS,
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  MAX_REDIRECT_URI_LENGTH
} from '../src/mcp/mcp-oauth.service';
import { McpOAuthController } from '../src/mcp/mcp-oauth.controller';
import { RateLimitService, RATE_LIMIT_CONFIGS } from '../src/auth/rate-limit.service';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-registration';

function memoryPrisma() {
  const clients: Record<string, any> = {};
  return {
    clients,
    mcpOauthClient: {
      create: async ({ data }: any) => {
        clients[data.id] = data;
      },
      findUnique: async ({ where }: any) => clients[where.id] ?? null
    },
    mcpOauthCode: { deleteMany: async () => ({ count: 0 }) }
  };
}

function memoryThrottle() {
  const buckets = new Map<string, { count: number; blockedUntil: number }>();
  return {
    available: true,
    retryAfter: async () => null,
    hit: async () => false,
    clear: async () => false,
    consume: async (key: string, config: any) => {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { count: 0, blockedUntil: 0 };
      if (bucket.blockedUntil > now) return Math.ceil((bucket.blockedUntil - now) / 1000);
      bucket.count += 1;
      buckets.set(key, bucket);
      if (bucket.count > config.maxAttempts) {
        bucket.blockedUntil = now + config.blockDurationMs;
        return Math.ceil(config.blockDurationMs / 1000);
      }
      return 0;
    }
  };
}

function fakeRes() {
  const out: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: any) {
      out.body = body;
      return res;
    }
  };
  return { res, out };
}

function req(ip: string, body: any) {
  return { headers: {}, socket: { remoteAddress: ip }, ip, body } as any;
}

function controller() {
  const prisma = memoryPrisma();
  const service = new McpOAuthService({} as any, prisma as any);
  const limiter = new RateLimitService({} as any, memoryThrottle() as any);
  return { ctl: new McpOAuthController(service, limiter), prisma, service };
}

const goodBody = { client_name: 'c', redirect_uris: ['https://client.example/cb'] };

test('one address is capped per day while another address still registers', async () => {
  const { ctl, prisma } = controller();
  const cap = RATE_LIMIT_CONFIGS.mcp_register_ip.maxAttempts;
  for (let i = 0; i < cap; i++) {
    const { res, out } = fakeRes();
    await ctl.registerClient(req('203.0.113.1', goodBody), res);
    assert.equal(out.status, 201);
  }
  const blocked = fakeRes();
  await ctl.registerClient(req('203.0.113.1', goodBody), blocked.res);
  assert.equal(blocked.out.status, 429);
  const other = fakeRes();
  await ctl.registerClient(req('203.0.113.2', goodBody), other.res);
  assert.equal(other.out.status, 201);
  assert.equal(Object.keys(prisma.clients).length, cap + 1);
});

test('registration rejects oversized metadata', async () => {
  const { service } = controller();
  const longName = await service.registerClient({
    client_name: 'n'.repeat(MAX_CLIENT_NAME_LENGTH + 1),
    redirect_uris: ['https://client.example/cb']
  });
  assert.equal(longName.error, 'invalid_client_metadata');
  const manyUris = await service.registerClient({
    redirect_uris: Array.from(
      { length: MAX_REDIRECT_URIS + 1 },
      (_, i) => `https://client.example/cb${i}`
    )
  });
  assert.equal(manyUris.error, 'invalid_client_metadata');
  const longUri = await service.registerClient({
    redirect_uris: [`https://client.example/${'a'.repeat(MAX_REDIRECT_URI_LENGTH)}`]
  });
  assert.equal(longUri.error, 'invalid_client_metadata');
  const fine = await service.registerClient({
    client_name: 'n'.repeat(MAX_CLIENT_NAME_LENGTH),
    redirect_uris: ['https://client.example/cb']
  });
  assert.ok(fine.registration);
});

test('the in-memory client map is bounded and falls back to the database', async () => {
  const { service, prisma } = controller();
  const first = await service.registerClient({ redirect_uris: ['https://client.example/cb'] });
  const firstId = first.registration.client_id;
  for (let i = 0; i < MAX_CACHED_CLIENTS + 10; i++) {
    (service as any).cacheClient(`filler${i}`, {
      clientId: `filler${i}`,
      redirectUris: [],
      name: 'f'
    });
  }
  assert.ok((service as any).oauthClients.size <= MAX_CACHED_CLIENTS);
  assert.equal((service as any).oauthClients.has(firstId), false);
  const reloaded = await (service as any).getClient(firstId);
  assert.equal(reloaded.clientId, firstId);
  assert.ok(prisma.clients[firstId]);
});
