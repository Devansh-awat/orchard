import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthService } from '../src/auth/oauth.service';

let server: Server;
let base = '';
let discovery: Record<string, unknown> = {};
let userinfo: Record<string, unknown> = {};
const tokenBodies: URLSearchParams[] = [];

before(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration') {
      return json({
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        ...discovery
      });
    }
    if (req.url === '/token') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        tokenBodies.push(new URLSearchParams(raw));
        json({ access_token: 'at' });
      });
      return;
    }
    if (req.url === '/userinfo') return json(userinfo);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function withOidc<T>(env: Record<string, string>, fn: (svc: OAuthService) => Promise<T>) {
  const keys = [
    'JWT_SECRET',
    'AUTH_PROVIDER',
    'AUTH_OAUTH_CLIENT_ID',
    'AUTH_OAUTH_CLIENT_SECRET',
    'AUTH_OAUTH_REDIRECT_URI',
    'AUTH_OAUTH_ISSUER',
    'AUTH_OAUTH_TRUST_EMAIL',
    'AUTH_OAUTH_PKCE'
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    JWT_SECRET: 'x'.repeat(40),
    AUTH_PROVIDER: 'oidc',
    AUTH_OAUTH_CLIENT_ID: 'client',
    AUTH_OAUTH_CLIENT_SECRET: 'secret',
    AUTH_OAUTH_REDIRECT_URI: 'https://orchard.test/apiv1/auth/callback',
    AUTH_OAUTH_ISSUER: base,
    ...env
  });
  try {
    return await fn(new OAuthService({} as any));
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a provider that omits email_verified signs in with an unverified email unless trusted', async () => {
  userinfo = { sub: 's1', email: 'ada@example.com', name: 'Ada' };
  assert.equal((await withOidc({}, (svc) => svc.getUserInfo('at'))).emailVerified, false);
  assert.equal(
    (await withOidc({ AUTH_OAUTH_TRUST_EMAIL: 'true' }, (svc) => svc.getUserInfo('at')))
      .emailVerified,
    true
  );
});

test('email_verified true is verified and false is refused, trusted or not', async () => {
  for (const claim of [true, 'true']) {
    userinfo = { sub: 's1', email: 'ada@example.com', email_verified: claim };
    assert.equal((await withOidc({}, (svc) => svc.getUserInfo('at'))).emailVerified, true);
  }
  for (const claim of [false, 'false']) {
    userinfo = { sub: 's1', email: 'ada@example.com', email_verified: claim };
    for (const env of [{}, { AUTH_OAUTH_TRUST_EMAIL: 'true' }]) {
      await assert.rejects(
        withOidc(env, (svc) => svc.getUserInfo('at')),
        /unverified/
      );
    }
  }
});

test('PKCE follows the discovery document unless AUTH_OAUTH_PKCE overrides it', async () => {
  for (const [advertised, env, expected] of [
    [['S256'], {}, true],
    [['plain'], {}, false],
    [undefined, {}, false],
    [undefined, { AUTH_OAUTH_PKCE: 'true' }, true],
    [['S256'], { AUTH_OAUTH_PKCE: 'false' }, false]
  ] as const) {
    discovery = advertised ? { code_challenge_methods_supported: advertised } : {};
    assert.equal(await withOidc(env, (svc) => svc.usesPkce()), expected);
  }
});

test('the challenge goes to the authorize URL and the verifier to the token exchange', async () => {
  discovery = { code_challenge_methods_supported: ['S256'] };
  await withOidc({}, async (svc) => {
    const url = new URL(await svc.getAuthorizationUrl('state-1', 'challenge-1'));
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const plain = new URL(await svc.getAuthorizationUrl('state-1'));
    assert.equal(plain.searchParams.has('code_challenge'), false);

    tokenBodies.length = 0;
    await svc.exchangeCodeForToken('code-1', 'verifier-1');
    await svc.exchangeCodeForToken('code-2');
    assert.equal(tokenBodies[0].get('code_verifier'), 'verifier-1');
    assert.equal(tokenBodies[1].has('code_verifier'), false);
  });
});
