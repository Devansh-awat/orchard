import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiTokensService,
  hashApiToken,
  parseTokenLineage,
  resolveTokenLineage
} from '../src/auth/api-tokens.service';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';
import { authenticateUpgrade } from '../src/kubernetes/exec-session-engine';

const DAY = 24 * 60 * 60 * 1000;
const PARENT = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';

type Row = { id: string; tokenHash: string; expiresAt: Date | null; userId: string; scopes: string[] };

function store() {
  const rows = new Map<string, Row>();
  const prisma: any = {
    apiToken: {
      create: async ({ data }: any) => {
        const row = { id: `new-${rows.size}`, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return rows.get(where.id) ?? null;
        return [...rows.values()].find((r) => r.tokenHash === where.tokenHash) ?? null;
      },
      findMany: async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
      }
    }
  };
  return { rows, prisma };
}

function service(prisma: any) {
  return new ApiTokensService(prisma, { log: async () => {} } as any, {} as any);
}

const ceiling = (lineage: string[] = [], tokenId = PARENT) => ({
  scopes: ['read', 'deploy', 'exec'],
  projectIds: [],
  tokenId,
  lineage
});

test('a minted token never outlives its parent', async () => {
  const { rows, prisma } = store();
  const parentExpiry = new Date(Date.now() + 2 * DAY);
  rows.set(PARENT, { id: PARENT, tokenHash: 'h', expiresAt: parentExpiry, userId: 'u', scopes: [] });
  const svc = service(prisma);

  const defaulted = await svc.create('u', 'child', undefined, ['read'], undefined, ceiling());
  assert.equal(defaulted.expiresAt!.getTime(), parentExpiry.getTime());

  const later = await svc.create(
    'u',
    'child',
    new Date(Date.now() + 30 * DAY),
    ['read'],
    undefined,
    ceiling()
  );
  assert.equal(later.expiresAt!.getTime(), parentExpiry.getTime());

  const sooner = new Date(Date.now() + DAY);
  const shorter = await svc.create('u', 'child', sooner, ['read'], undefined, ceiling());
  assert.equal(shorter.expiresAt!.getTime(), sooner.getTime());
});

test('a gone or expired parent cannot mint', async () => {
  const { rows, prisma } = store();
  const svc = service(prisma);
  await assert.rejects(() => svc.create('u', 'c', undefined, ['read'], undefined, ceiling()));
  rows.set(PARENT, {
    id: PARENT,
    tokenHash: 'h',
    expiresAt: new Date(Date.now() - 1000),
    userId: 'u',
    scopes: []
  });
  await assert.rejects(() => svc.create('u', 'c', undefined, ['read'], undefined, ceiling()));
});

test('the minting chain is embedded in the plaintext and tied to the stored hash', async () => {
  const { rows, prisma } = store();
  rows.set(PARENT, { id: PARENT, tokenHash: 'h', expiresAt: null, userId: 'u', scopes: [] });
  const svc = service(prisma);
  const child = await svc.create('u', 'c', undefined, ['read'], undefined, ceiling([ROOT]));
  assert.match(child.token, new RegExp(`^orch_[0-9a-f]{64}\\.${ROOT}\\.${PARENT}$`));
  assert.deepEqual(parseTokenLineage(child.token), [ROOT, PARENT]);
  const stored = [...rows.values()].find((r) => r.tokenHash === hashApiToken(child.token));
  assert.ok(stored);
  const edited = child.token.replace(PARENT, ROOT);
  assert.equal([...rows.values()].some((r) => r.tokenHash === hashApiToken(edited)), false);

  const root = await svc.create('u', 'root', undefined, ['read']);
  assert.match(root.token, /^orch_[0-9a-f]{64}$/);
});

test('a child dies with its parent, and a root token costs no extra lookup', async () => {
  const { rows, prisma } = store();
  let lookups = 0;
  const counted = { apiToken: { findMany: (a: any) => (lookups++, prisma.apiToken.findMany(a)) } };
  const rootToken = `orch_${'a'.repeat(64)}`;
  assert.deepEqual(await resolveTokenLineage(counted, rootToken), []);
  assert.equal(lookups, 0);

  const child = `orch_${'b'.repeat(64)}.${ROOT}.${PARENT}`;
  rows.set(ROOT, { id: ROOT, tokenHash: 'r', expiresAt: null, userId: 'u', scopes: [] });
  rows.set(PARENT, { id: PARENT, tokenHash: 'p', expiresAt: null, userId: 'u', scopes: [] });
  assert.deepEqual(await resolveTokenLineage(counted, child), [ROOT, PARENT]);

  rows.get(PARENT)!.expiresAt = new Date(Date.now() - 1);
  assert.equal(await resolveTokenLineage(counted, child), null);
  rows.get(PARENT)!.expiresAt = null;
  rows.delete(ROOT);
  assert.equal(await resolveTokenLineage(counted, child), null);
  assert.equal(await resolveTokenLineage(counted, `orch_${'b'.repeat(64)}.not-a-uuid`), null);
});

test('the MCP endpoint rejects a child once its parent is revoked', async () => {
  const { rows, prisma } = store();
  rows.set(PARENT, { id: PARENT, tokenHash: 'p', expiresAt: null, userId: 'u', scopes: [] });
  const child = `orch_${'c'.repeat(64)}.${PARENT}`;
  rows.set('child', {
    id: 'child',
    tokenHash: hashApiToken(child),
    expiresAt: null,
    userId: 'u',
    scopes: ['read']
  });
  const svc = new McpOAuthService({} as any, prisma as any);
  assert.ok(await svc.validateApiToken(`Bearer ${child}`));
  rows.delete(PARENT);
  assert.equal(await svc.validateApiToken(`Bearer ${child}`), null);
});

test('the exec upgrade rejects a child once its parent is revoked', async () => {
  const { rows, prisma } = store();
  rows.set(PARENT, { id: PARENT, tokenHash: 'p', expiresAt: null, userId: 'u', scopes: [] });
  const child = `orch_${'d'.repeat(64)}.${PARENT}`;
  rows.set('child', {
    id: 'child',
    tokenHash: hashApiToken(child),
    expiresAt: null,
    userId: 'u',
    scopes: ['exec']
  });
  const row = rows.get('child') as any;
  row.user = { id: 'u', email: 'u@example.test' };
  prisma.apiToken.update = async () => ({});
  const req: any = { headers: { authorization: `Bearer ${child}` } };
  const deps: any = { prisma, sessions: {}, jwtSecret: new TextEncoder().encode('x') };
  const ok = await authenticateUpgrade(req, deps);
  assert.equal((ok as any).userId, 'u');
  assert.deepEqual((ok as any).tokenLineage, [PARENT]);
  rows.delete(PARENT);
  assert.deepEqual(await authenticateUpgrade(req, deps), { reject: 401, message: 'Unauthorized' });
});
