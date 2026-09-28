import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'protection-password-throttle-secret';
process.env.FRONTEND_URL = 'https://orchard.test';

// oxlint-disable-next-line import/first
import { ProtectionController } from '../src/auth/protection.controller';
// oxlint-disable-next-line import/first
import { RateLimitService } from '../src/auth/rate-limit.service';
// oxlint-disable-next-line import/first
import { TurnstileService } from '../src/auth/turnstile.service';

const ING = 'aaaaaaaa-0000-0000-0000-000000000001';
const RETURN_TO = 'https://private.example.test/secret';

function fakePrisma() {
  const rows: any[] = [];
  const find = (w: any) =>
    rows.find((r) => r.identifier === w.identifier && r.type === w.type && r.action === w.action) ||
    null;
  return {
    rateLimitRecord: {
      findUnique: async ({ where }: any) => find(where.identifier_type_action),
      create: async ({ data }: any) => {
        const row = { id: String(rows.length + 1), blockedUntil: null, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            v && typeof v === 'object' && 'increment' in (v as any)
              ? row[k] + (v as any).increment
              : v;
        }
        return row;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (
            r.identifier === where.identifier &&
            r.type === where.type &&
            r.action === where.action
          ) {
            rows.splice(i, 1);
            count++;
          }
        }
        return { count };
      }
    }
  };
}

const offlineThrottle = {
  available: false,
  retryAfter: async () => null,
  consume: async () => null,
  hit: async () => false,
  clear: async () => false
};

function buildController(correctPassword: string) {
  const rateLimit = new RateLimitService(fakePrisma() as any, offlineThrottle as any);
  const protection = {
    validateReturnTo: async () => {},
    verifyPassword: async (_id: string, pw: string) => pw === correctPassword,
    generateExchangeToken: async () => 'token'
  };
  const turnstile = new TurnstileService({
    isConfigured: () => false,
    value: () => null
  } as any);
  return new ProtectionController(protection as any, rateLimit, turnstile);
}

const req = (ip: string) => ({ headers: { 'x-real-ip': ip }, ip, socket: {} }) as any;
const body = (password: string) => ({ ingressId: ING, password, returnTo: RETURN_TO });

async function attempt(ctrl: ProtectionController, ip: string, password: string) {
  try {
    await ctrl.exchangePassword(req(ip), body(password));
    return 200;
  } catch (e: any) {
    return e.getStatus?.() ?? 500;
  }
}

test('a wrong password is 403 until the bucket runs out, then 429', async () => {
  const ctrl = buildController('correct horse');
  for (let i = 0; i < 10; i++) {
    assert.equal(await attempt(ctrl, '203.0.113.9', `guess-${i}`), 403, `guess ${i + 1}`);
  }
  assert.equal(
    await attempt(ctrl, '203.0.113.9', 'guess-10'),
    429,
    'an unlimited stream of guesses is the whole vulnerability'
  );
});

test('a throttled client is refused even with the right password', async () => {
  const ctrl = buildController('correct horse');
  for (let i = 0; i < 10; i++) await attempt(ctrl, '203.0.113.9', `guess-${i}`);
  assert.equal(await attempt(ctrl, '203.0.113.9', 'correct horse'), 429);
});

test('one attacker does not lock out everybody else', async () => {
  const ctrl = buildController('correct horse');
  for (let i = 0; i < 20; i++) await attempt(ctrl, '203.0.113.9', `guess-${i}`);
  assert.equal(await attempt(ctrl, '198.51.100.4', 'correct horse'), 200);
});

test('a success gives that client its attempts back', async () => {
  const ctrl = buildController('correct horse');
  for (let i = 0; i < 9; i++) await attempt(ctrl, '203.0.113.9', `guess-${i}`);
  assert.equal(await attempt(ctrl, '203.0.113.9', 'correct horse'), 200);
  assert.equal(await attempt(ctrl, '203.0.113.9', 'wrong again'), 403);
});

test('spreading the guess across addresses still hits the per-ingress ceiling', async () => {
  // The per-IP bucket alone is worth little to somebody with a botnet or a
  // rotating proxy, so the ingress keeps its own count of failures.
  const ctrl = buildController('correct horse');
  let throttled = false;
  for (let i = 0; i < 120 && !throttled; i++) {
    const status = await attempt(ctrl, `198.51.100.${i % 256}`, `guess-${i}`);
    if (status === 429) throttled = true;
  }
  assert.ok(throttled, 'a distributed guess must eventually be throttled too');
});

test('the per-IP bucket is scoped to one ingress', async () => {
  // A shared NAT behind one throttled deployment must still reach the others.
  const ctrl = buildController('correct horse');
  for (let i = 0; i < 12; i++) await attempt(ctrl, '203.0.113.9', `guess-${i}`);

  const other = {
    ingressId: 'bbbbbbbb-0000-0000-0000-000000000002',
    password: 'correct horse',
    returnTo: RETURN_TO
  };
  const res = await ctrl.exchangePassword(req('203.0.113.9'), other);
  assert.match(res.redirectUrl, /__orchard_token=/);
});
