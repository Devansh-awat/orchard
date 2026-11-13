import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor } from '../src/git/providers';
import type { ConnectionConfig } from '../src/git/git-provider';
import { setGuardedFetchTransport } from '../src/notifications/webhook-guard';

const HOOK = 'https://orchard.example.com/apiv1/git/webhooks/conn-1';

function stubFetch(
  routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    const handler = routes[key];
    if (!handler) return new Response('nope', { status: 404 });
    const { status, body } = handler(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  setGuardedFetchTransport(stub);
  return {
    calls,
    restore: () => {
      setGuardedFetchTransport(null);
    }
  };
}

const gitea: ConnectionConfig = {
  kind: 'gitea',
  baseUrl: 'https://codeberg.org',
  username: null,
  token: 't',
  webhookSecret: 's3cret'
};
const gitlab: ConnectionConfig = {
  kind: 'gitlab',
  baseUrl: 'https://gitlab.com',
  username: null,
  token: 't',
  webhookSecret: 's3cret'
};

test('turning auto-deploy on registers a push hook with the connection secret', async () => {
  const { calls, restore } = stubFetch({
    'GET /api/v1/repos/team/app/hooks': () => ({ status: 200, body: [] }),
    'POST /api/v1/repos/team/app/hooks': () => ({ status: 201, body: { id: 9 } })
  });
  try {
    const result = await providerFor(gitea).ensureWebhook('team/app', HOOK, 's3cret');
    assert.equal(result, 'registered');
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.deepEqual(post.body, {
      type: 'gitea',
      active: true,
      events: ['push'],
      config: { url: HOOK, content_type: 'json', secret: 's3cret' }
    });
  } finally {
    restore();
  }
});

test('a hook that already exists is left alone, and gitlab uses its own shape', async () => {
  const { calls, restore } = stubFetch({
    'GET /api/v4/projects/group%2Fapp/hooks': () => ({ status: 200, body: [{ id: 1, url: HOOK }] })
  });
  try {
    assert.equal(await providerFor(gitlab).ensureWebhook('group/app', HOOK, 's3cret'), 'exists');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(await providerFor(gitlab).hasWebhook('group/app', HOOK), true);
  } finally {
    restore();
  }
});

test('a generic host cannot be asked, so the manual route stays', async () => {
  const generic: ConnectionConfig = {
    ...gitea,
    kind: 'generic',
    baseUrl: 'https://git.example.internal'
  };
  assert.equal(await providerFor(generic).ensureWebhook('a/b', HOOK, 's'), 'unsupported');
  assert.equal(await providerFor(generic).hasWebhook('a/b', HOOK), null);
});
