import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { providerFor } from '../src/git/providers';
import {
  BITBUCKET_APP_PASSWORD_RETIRED,
  BITBUCKET_TOKEN_REJECTED,
  GitProviderError,
  isBitbucketAppPassword,
  providerFailureMessage,
  type ConnectionConfig
} from '../src/git/git-provider';
import { GitConnectionsService } from '../src/git/git-connections.service';
import { setGuardedFetchTransport } from '../src/notifications/webhook-guard';

function captureAuth(status = 200) {
  const seen: { url: string; authorization: string | null }[] = [];
  setGuardedFetchTransport((async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get('authorization') });
    return new Response(JSON.stringify({ values: [] }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch);
  return { seen, restore: () => setGuardedFetchTransport(null) };
}

const bitbucket = (username: string | null): ConnectionConfig => ({
  kind: 'bitbucket',
  baseUrl: 'https://bitbucket.org',
  username,
  token: 'ATATT-token',
  webhookSecret: 's'
});

test('an api token with its account email signs the api in with the email and git with the token user', async () => {
  const { seen, restore } = captureAuth();
  try {
    const provider = providerFor(bitbucket('dev@example.com'));
    await provider.listRepos();
    const expected = `Basic ${Buffer.from('dev@example.com:ATATT-token').toString('base64')}`;
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.startsWith('https://api.bitbucket.org/2.0/repositories'));
    assert.equal(seen[0].authorization, expected);
    assert.deepEqual(provider.cloneCredential(), {
      host: 'bitbucket.org',
      username: 'x-bitbucket-api-token-auth',
      password: 'ATATT-token'
    });
  } finally {
    restore();
  }
});

test('a token without an email is a bearer token for the api and x-token-auth for git', async () => {
  const { seen, restore } = captureAuth();
  try {
    const provider = providerFor(bitbucket(null));
    await provider.listBranches('team/app');
    assert.equal(seen[0].authorization, 'Bearer ATATT-token');
    assert.deepEqual(provider.cloneCredential(), {
      host: 'bitbucket.org',
      username: 'x-token-auth',
      password: 'ATATT-token'
    });
  } finally {
    restore();
  }
});

test('a bitbucket username is never sent as the api or git user', async () => {
  const { seen, restore } = captureAuth();
  try {
    const provider = providerFor(bitbucket('devuser'));
    await provider.listRepos();
    assert.equal(seen[0].authorization, 'Bearer ATATT-token');
    assert.equal(provider.cloneCredential().username, 'x-token-auth');
  } finally {
    restore();
  }
});

test('only a pasted bitbucket connection with a plain username reads as an app password', () => {
  assert.equal(
    isBitbucketAppPassword({ provider: 'bitbucket', oauth: false, username: 'devuser' }),
    true
  );
  assert.equal(
    isBitbucketAppPassword({ provider: 'bitbucket', oauth: false, username: 'dev@example.com' }),
    false
  );
  assert.equal(
    isBitbucketAppPassword({ provider: 'bitbucket', oauth: false, username: null }),
    false
  );
  assert.equal(
    isBitbucketAppPassword({ provider: 'bitbucket', oauth: true, username: 'x' }),
    false
  );
  assert.equal(isBitbucketAppPassword({ provider: 'generic', oauth: false, username: 'x' }), false);
  const denied = new GitProviderError('nope', 401);
  assert.equal(providerFailureMessage(denied, 'bitbucket'), BITBUCKET_TOKEN_REJECTED);
  assert.equal(providerFailureMessage(denied, 'gitlab'), 'The provider rejected the token');
});

function service(row: Record<string, unknown> | null = null) {
  const created: Record<string, unknown>[] = [];
  const svc = Object.create(GitConnectionsService.prototype) as GitConnectionsService;
  Object.assign(svc, {
    prisma: {
      gitConnection: {
        findFirst: async () => null,
        findUnique: async () => row,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return {
            id: 'conn-1',
            oauth: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data
          };
        }
      }
    },
    audit: { log: async () => undefined },
    crypto: {
      encrypt: (v: string) => `enc:${v}`,
      decrypt: (v: string) => v.replace(/^enc:/, ''),
      seal: (v: string) => `sealed:${v}`,
      open: (v: string) => v.replace(/^sealed:/, '')
    }
  });
  return { svc, created };
}

test('linking bitbucket asks for the account email, not the bitbucket username', async () => {
  const { svc } = service();
  await assert.rejects(
    svc.create('u1', { provider: 'bitbucket', name: 'bb', username: 'devuser', token: 't' }),
    /email of your Atlassian account/
  );
});

test('a bitbucket api token is checked against the api and stored encrypted with its email', async () => {
  const { seen, restore } = captureAuth();
  const { svc, created } = service();
  try {
    const view = await svc.create('u1', {
      provider: 'bitbucket',
      name: 'bb',
      username: 'dev@example.com',
      token: 'ATATT-token'
    });
    assert.equal(view.username, 'dev@example.com');
    assert.equal(created[0].token, 'enc:ATATT-token');
    assert.match(String(seen[0].authorization), /^Basic /);
  } finally {
    restore();
  }
});

test('a rejected bitbucket api token fails on save with the scopes to check', async () => {
  const { restore } = captureAuth(401);
  const { svc } = service();
  try {
    await assert.rejects(
      svc.create('u1', {
        provider: 'bitbucket',
        name: 'bb',
        username: 'dev@example.com',
        token: 'bad'
      }),
      (e: unknown) => e instanceof BadRequestException && e.message === BITBUCKET_TOKEN_REJECTED
    );
  } finally {
    restore();
  }
});

for (const status of [401, 410]) {
  test(`an old app password connection answered with ${status} tells the owner to reconnect`, async () => {
    const { restore } = captureAuth(status);
    const { svc } = service({
      id: 'conn-1',
      userId: 'u1',
      provider: 'bitbucket',
      name: 'bb',
      baseUrl: 'https://bitbucket.org',
      username: 'devuser',
      token: 'enc:app-password',
      webhookSecret: 'sealed:s',
      oauth: false,
      refreshToken: null,
      tokenExpiresAt: null
    });
    try {
      await assert.rejects(
        svc.repos('u1', 'conn-1'),
        (e: unknown) =>
          e instanceof BadRequestException && e.message === BITBUCKET_APP_PASSWORD_RETIRED
      );
    } finally {
      restore();
    }
  });
}
