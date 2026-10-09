import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_USAGE_TTL_MS,
  ANTHROPIC_OAUTH_PROFILE_URL,
  ANTHROPIC_OAUTH_USAGE_URL,
  SandboxAgentUsageService,
  maskEmail,
  profilePlan,
  usageWindow
} from '../src/sandboxes/sandbox-agent-usage.service';

const HOST = 'host-user';
const GUEST = 'guest-user';
const TOKEN = 'sk-ant-oat01-secret-token-value';

function service(
  token: string | null,
  responses: Record<string, () => Response | Promise<Response>>
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const prisma = {
    sandboxCredential: {
      async findUnique() {
        return token === null ? null : { claudeToken: `sealed:${token}` };
      }
    }
  };
  const crypto = { decrypt: (value: string) => value.replace(/^sealed:/, '') };
  const svc = new SandboxAgentUsageService(prisma as any, crypto as any);
  let clock = 1_000_000;
  svc.now = () => clock;
  svc.fetcher = async (url, init) => {
    calls.push({ url, init });
    const respond = responses[url];
    if (!respond) throw new Error(`unexpected ${url}`);
    return respond();
  };
  return {
    svc,
    calls,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const USAGE = {
  five_hour: { utilization: 32, resets_at: '2026-10-08T21:39:00Z' },
  seven_day: { utilization: 74.5, resets_at: '2026-10-11T18:59:00Z' },
  seven_day_opus: null
};

const PROFILE = {
  account: { email: 'sanchez@example.com', has_claude_max: true },
  organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' }
};

test('the host sees usage, plan and their own email from the OAuth endpoints', async () => {
  const { svc, calls } = service(TOKEN, {
    [ANTHROPIC_OAUTH_USAGE_URL]: () => json(USAGE),
    [ANTHROPIC_OAUTH_PROFILE_URL]: () => json(PROFILE)
  });
  const usage = await svc.forSandbox({ userId: HOST }, HOST);
  assert.equal(usage.available, true);
  if (!usage.available) return;
  assert.deepEqual(usage.fiveHour, {
    usedPercent: 32,
    leftPercent: 68,
    resetsAt: '2026-10-08T21:39:00.000Z'
  });
  assert.equal(usage.sevenDay?.leftPercent, 25.5);
  assert.equal(usage.plan, 'Max 20x');
  assert.equal(usage.email, 'sanchez@example.com');
  assert.equal(usage.emailMasked, false);
  assert.equal(usage.provider, 'Anthropic');
  assert.equal(usage.loginMethod, 'Claude account');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.ok(call.init.signal, 'every call has a timeout signal');
  }
  assert.ok(!JSON.stringify(usage).includes(TOKEN), 'the token never leaves the server');
});

test('guests get the host email masked', async () => {
  const { svc } = service(TOKEN, {
    [ANTHROPIC_OAUTH_USAGE_URL]: () => json(USAGE),
    [ANTHROPIC_OAUTH_PROFILE_URL]: () => json(PROFILE)
  });
  const usage = await svc.forSandbox({ userId: HOST }, GUEST);
  assert.equal(usage.available, true);
  if (!usage.available) return;
  assert.equal(usage.email, 's***z@example.com');
  assert.equal(usage.emailMasked, true);
  const again = await svc.forSandbox({ userId: HOST }, HOST);
  assert.equal(
    again.available && again.email,
    'sanchez@example.com',
    'masking never sticks to the cache'
  );
});

test('results are cached for a minute per host and concurrent calls share one fetch', async () => {
  const { svc, calls, advance } = service(TOKEN, {
    [ANTHROPIC_OAUTH_USAGE_URL]: () => json(USAGE),
    [ANTHROPIC_OAUTH_PROFILE_URL]: () => json(PROFILE)
  });
  await Promise.all([
    svc.forSandbox({ userId: HOST }, HOST),
    svc.forSandbox({ userId: HOST }, GUEST)
  ]);
  assert.equal(calls.length, 2);
  advance(AGENT_USAGE_TTL_MS - 1);
  await svc.forSandbox({ userId: HOST }, GUEST);
  assert.equal(calls.length, 2);
  advance(2);
  await svc.forSandbox({ userId: HOST }, GUEST);
  assert.equal(calls.length, 4);
});

test('an API key never reaches Anthropic and reports why', async () => {
  const { svc, calls } = service('sk-ant-api03-abc', {});
  assert.deepEqual(await svc.forSandbox({ userId: HOST }, HOST), {
    available: false,
    reason: 'api_key'
  });
  assert.equal(calls.length, 0);
});

test('no stored token reports no_token', async () => {
  const { svc, calls } = service(null, {});
  assert.deepEqual(await svc.forSandbox({ userId: HOST }, GUEST), {
    available: false,
    reason: 'no_token'
  });
  assert.equal(calls.length, 0);
});

test('failures and timeouts degrade to unavailable without throwing', async () => {
  const { svc } = service(TOKEN, {
    [ANTHROPIC_OAUTH_USAGE_URL]: () => json({ error: 'scope' }, 403),
    [ANTHROPIC_OAUTH_PROFILE_URL]: () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }
  });
  assert.deepEqual(await svc.forSandbox({ userId: HOST }, HOST), {
    available: false,
    reason: 'unavailable'
  });
});

test('a usage answer without a profile still shows the limits', async () => {
  const { svc } = service(TOKEN, {
    [ANTHROPIC_OAUTH_USAGE_URL]: () => json(USAGE),
    [ANTHROPIC_OAUTH_PROFILE_URL]: () => json({}, 401)
  });
  const usage = await svc.forSandbox({ userId: HOST }, GUEST);
  assert.equal(usage.available, true);
  if (!usage.available) return;
  assert.equal(usage.plan, null);
  assert.equal(usage.email, null);
  assert.equal(usage.fiveHour?.usedPercent, 32);
});

test('parsers clamp and validate what Anthropic sends', () => {
  assert.equal(usageWindow(null), null);
  assert.equal(usageWindow({ utilization: 'x' }), null);
  assert.deepEqual(usageWindow({ utilization: 140, resets_at: 'nope' }), {
    usedPercent: 100,
    leftPercent: 0,
    resetsAt: null
  });
  assert.equal(profilePlan({ organization: { organization_type: 'claude_pro' } }), 'Pro');
  assert.equal(profilePlan({ account: { has_claude_max: true } }), 'Max');
  assert.equal(profilePlan({}), null);
  assert.equal(maskEmail('ab@x.io'), 'a***@x.io');
  assert.equal(maskEmail('nope'), '***');
});
