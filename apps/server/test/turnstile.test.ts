import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnstileService } from '../src/auth/turnstile.service';
import { TURNSTILE } from '../src/instance-config/instance-config.sections';

type Values = Record<string, string | null>;

function fakeConfig(values: Values) {
  return {
    isConfigured: (section: any) =>
      section === TURNSTILE ? !!values.siteKey && !!values.secretKey : false,
    value: (_section: any, name: string) => values[name] ?? null,
    flag: (section: any, name: string) => {
      const field = section.fields.find((f: any) => f.name === name);
      const raw = values[name];
      if (raw === null || raw === undefined) return field?.fallback ?? false;
      return raw.trim().toLowerCase() === 'true';
    }
  } as any;
}

function build(values: Values) {
  const service = new TurnstileService(fakeConfig(values));
  (service as any).logger = { warn() {}, error() {} };
  return service;
}

const configured: Values = { siteKey: 'site', secretKey: 'secret' };
const strict: Values = { ...configured, strict: 'true' };

function req(token?: string) {
  return { headers: token ? { 'x-turnstile-token': token } : {} } as any;
}

function withFetch(
  impl: (url: string, init: any) => Promise<unknown>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => impl(String(url), init)) as any;
  return fn().finally(() => {
    globalThis.fetch = previous;
  });
}

function ok(payload: Record<string, unknown>) {
  return async () => ({ ok: true, status: 200, json: async () => payload }) as any;
}

const unreachable = async () => {
  throw new Error('ECONNREFUSED');
};

test('an instance with no keys enforces nothing and advertises no site key', async () => {
  const service = build({ siteKey: null, secretKey: null });
  assert.equal(service.isEnabled(), false);
  assert.equal(service.siteKey(), null);
  await withFetch(
    async () => assert.fail('siteverify must not be called when no keys are set'),
    async () => {
      await service.verifyRequest(req(), 'signin', '203.0.113.1');
    }
  );
});

test('half-configured is still off, so a missing secret cannot lock anyone out', async () => {
  const service = build({ siteKey: 'site', secretKey: null });
  assert.equal(service.isEnabled(), false);
  assert.equal(service.siteKey(), null);
});

test('keys present means on, because the toggle defaults to enforcing', async () => {
  assert.equal(build(configured).isEnabled(), true);
});

test('the enabled toggle turns enforcement off without discarding the keys', async () => {
  const service = build({ ...configured, enabled: 'false' });
  assert.equal(service.isEnabled(), false);
  assert.equal(service.siteKey(), null);
  await withFetch(
    async () => assert.fail('siteverify must not be called while disabled'),
    async () => {
      await service.verifyRequest(req(), 'signin', null);
    }
  );
});

test('strict is off by default', async () => {
  assert.equal(build(configured).isStrict(), false);
  assert.equal(build(strict).isStrict(), true);
});

test('a configured instance refuses a request that carries no token', async () => {
  const service = build(configured);
  assert.equal(service.siteKey(), 'site');
  await assert.rejects(() => service.verifyRequest(req(), 'signin', null), /Bot check failed/);
});

test('a solved token for the right surface passes and carries the caller address', async () => {
  const service = build(configured);
  let sent: URLSearchParams | null = null;
  await withFetch(
    async (_url, init) => {
      sent = init.body as URLSearchParams;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, action: 'signin' })
      } as any;
    },
    async () => {
      await service.verifyRequest(req('tok'), 'signin', '203.0.113.7');
    }
  );
  assert.equal(sent!.get('secret'), 'secret');
  assert.equal(sent!.get('response'), 'tok');
  assert.equal(sent!.get('remoteip'), '203.0.113.7');
});

test('a token solved on another surface is refused', async () => {
  const service = build(configured);
  await withFetch(ok({ success: true, action: 'protection' }), async () => {
    await assert.rejects(
      () => service.verifyRequest(req('tok'), 'signin', null),
      /Bot check failed/
    );
  });
});

test('a token with no action at all is refused', async () => {
  const service = build(configured);
  await withFetch(ok({ success: true }), async () => {
    await assert.rejects(
      () => service.verifyRequest(req('tok'), 'signin', null),
      /Bot check failed/
    );
  });
});

test('a rejected token is refused even when strict is off', async () => {
  const service = build(configured);
  await withFetch(ok({ success: false, 'error-codes': ['timeout-or-duplicate'] }), async () => {
    await assert.rejects(
      () => service.verifyRequest(req('tok'), 'signin', null),
      /Bot check failed/
    );
  });
});

test('an unreachable siteverify lets the request through by default', async () => {
  const service = build(configured);
  await withFetch(unreachable, async () => {
    await service.verifyRequest(req('tok'), 'signin', null);
  });
});

test('a siteverify error status lets the request through by default', async () => {
  const service = build(configured);
  await withFetch(
    async () => ({ ok: false, status: 502, json: async () => ({}) }) as any,
    async () => {
      await service.verifyRequest(req('tok'), 'signin', null);
    }
  );
});

test('an unreadable siteverify body lets the request through by default', async () => {
  const service = build(configured);
  await withFetch(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        }
      }) as any,
    async () => {
      await service.verifyRequest(req('tok'), 'signin', null);
    }
  );
});

test('strict refuses an unreachable siteverify instead', async () => {
  const service = build(strict);
  await withFetch(unreachable, async () => {
    await assert.rejects(
      () => service.verifyRequest(req('tok'), 'signin', null),
      /Could not reach the bot check/
    );
  });
});

test('strict refuses a siteverify error status instead', async () => {
  const service = build(strict);
  await withFetch(
    async () => ({ ok: false, status: 502, json: async () => ({}) }) as any,
    async () => {
      await assert.rejects(
        () => service.verifyRequest(req('tok'), 'signin', null),
        /Could not reach the bot check/
      );
    }
  );
});

test('a missing token is still refused when the check is unreachable', async () => {
  const service = build(configured);
  await withFetch(
    async () => assert.fail('a request with no token never reaches siteverify'),
    async () => {
      await assert.rejects(() => service.verifyRequest(req(), 'signin', null), /Bot check failed/);
    }
  );
});
