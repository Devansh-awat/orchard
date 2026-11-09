import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService, signInLocationEnabled } from '../src/auth/sessions.service';

type Field = { name: string; value: string };

function world() {
  const created: { location?: string | null }[] = [];
  const alerts: { fields: Field[] }[] = [];
  const audits: { metadata: { location: string | null } }[] = [];
  const service = new SessionsService(
    {
      user: { findUnique: async () => ({ disabledAt: null }) },
      session: {
        create: async ({ data }: { data: { location?: string | null } }) => {
          created.push(data);
          return { id: 'session-1' };
        }
      }
    } as never,
    { log: async (entry: (typeof audits)[number]) => audits.push(entry) } as never,
    {
      get: () => ({
        notifySecurity: async (_userId: string, alert: (typeof alerts)[number]) => {
          alerts.push(alert);
        }
      })
    } as never
  );
  return { service, created, alerts, audits };
}

let calls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  delete process.env.SIGN_IN_LOCATION_LOOKUP;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true, city: 'Boston', country: 'US' }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SIGN_IN_LOCATION_LOOKUP;
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the lookup is off unless it is set to true', () => {
  assert.equal(signInLocationEnabled({}), false);
  assert.equal(signInLocationEnabled({ SIGN_IN_LOCATION_LOOKUP: '' }), false);
  assert.equal(signInLocationEnabled({ SIGN_IN_LOCATION_LOOKUP: 'false' }), false);
  assert.equal(signInLocationEnabled({ SIGN_IN_LOCATION_LOOKUP: 'TRUE' }), true);
});

test('a default sign-in contacts nothing and still records the session', async () => {
  const { service, created, alerts, audits } = world();
  assert.equal(await service.createSession({ userId: 'u1', ipAddress: '8.8.8.8' }), 'session-1');
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(created[0].location, null);
  assert.equal(audits[0].metadata.location, null);
  assert.deepEqual(
    alerts[0].fields.map((f) => f.name),
    ['IP address']
  );
});

test('with the lookup on, the location reaches the session and the alert', async () => {
  process.env.SIGN_IN_LOCATION_LOOKUP = 'true';
  const { service, created, alerts } = world();
  await service.createSession({ userId: 'u1', ipAddress: '8.8.8.8' });
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/ipwho\.is\/8\.8\.8\.8/);
  assert.equal(created[0].location, 'Boston, US');
  assert.ok(alerts[0].fields.some((f) => f.name === 'Location' && f.value === 'Boston, US'));
});

test('with the lookup on, private addresses are still not sent', async () => {
  process.env.SIGN_IN_LOCATION_LOOKUP = 'true';
  const { service, created } = world();
  await service.createSession({ userId: 'u1', ipAddress: '10.1.2.3' });
  assert.deepEqual(calls, []);
  assert.equal(created[0].location, null);
});
