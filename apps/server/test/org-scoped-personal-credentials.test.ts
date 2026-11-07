import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { GitHubService } from '../src/github/github.service';
import { GitConnectionsService } from '../src/git/git-connections.service';
import { ComposeStacksService } from '../src/compose-stacks/compose-stacks.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { requestAuthStorage, type RequestAuthContext } from '../src/auth/request-context';

const crypto = new SecretCryptoService();
const ORG = '11111111-1111-4111-8111-111111111111';

function stubFetch(privateRepo = true) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ visibility: privateRepo ? 'private' : 'public', private: privateRepo })
    } as any;
  }) as any;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function githubService() {
  const prisma = {
    user: {
      findUnique: async () => ({
        githubAccessToken: crypto.seal('personal-token'),
        githubTokenExpiresAt: null,
        githubRefreshToken: null
      })
    },
    gitHubAppInstallation: { findMany: async () => [] }
  };
  const svc = new GitHubService(prisma as any, {} as any, {} as any, {} as any, crypto);
  (svc as any).installationsEpoch = async () => '0';
  (svc as any).findInstallationForRepo = async () => null;
  return svc;
}

function as<T>(ctx: RequestAuthContext | undefined, fn: () => Promise<T>): Promise<T> {
  return ctx ? requestAuthStorage.run(ctx, fn) : fn();
}

const user = { id: 'u1', githubAccessToken: 'sealed' };

test('normal session keeps using the personal GitHub link', async () => {
  const f = stubFetch();
  try {
    const svc = githubService();
    assert.equal(await as({}, () => svc.getValidUserToken('u1')), 'personal-token');
    assert.equal(await as({}, () => svc.verifyUserCanAccessRepo('u1', 'a', 'b')), true);
    assert.equal(await as({}, () => svc.resolveReadAccessToken(user, 'a', 'b')), 'personal-token');
  } finally {
    f.restore();
  }
});

test('org-scoped credential never gets the personal GitHub token', async () => {
  const f = stubFetch();
  try {
    const svc = githubService();
    const ctx = { sessionOrgId: ORG };
    assert.equal(await as(ctx, () => svc.getValidUserToken('u1')), null);
    assert.equal(await as(ctx, () => svc.verifyUserCanAccessRepo('u1', 'a', 'b')), false);
    assert.equal(await as(ctx, () => svc.userMaintainsRepo('u1', 'a', 'b')), false);
    assert.equal(await as(ctx, () => svc.resolveRepoToken('u1', 'a', 'b')), null);
    assert.equal(await as(ctx, () => svc.resolveReadAccessToken(user, 'a', 'b')), null);
    assert.ok(f.urls.every((u) => !u.includes('/installation')));
  } finally {
    f.restore();
  }
});

test('org-scoped credential can still import a public repo without a token', async () => {
  const f = stubFetch(false);
  try {
    const svc = githubService();
    assert.equal(
      await as({ sessionOrgId: ORG }, () => svc.resolveReadAccessToken(user, 'a', 'b')),
      ''
    );
  } finally {
    f.restore();
  }
});

test('project-scoped token cannot pick a personal repo as a new source', async () => {
  const f = stubFetch();
  try {
    const svc = githubService();
    const ctx = { tokenProjectIds: ['p1'] };
    assert.equal(await as(ctx, () => svc.verifyUserCanAccessRepo('u1', 'a', 'b')), false);
    assert.equal(await as(ctx, () => svc.resolveReadAccessToken(user, 'a', 'b')), null);
  } finally {
    f.restore();
  }
});

function connections() {
  const row = { id: 'c1', userId: 'u1' };
  const prisma = { gitConnection: { findUnique: async () => row } };
  return new GitConnectionsService(prisma as any, {} as any, crypto, {} as any, {} as any);
}

test('forDeploy refuses personal connections for org-scoped and project tokens', async () => {
  const svc = connections();
  for (const ctx of [{ sessionOrgId: ORG }, { tokenProjectIds: ['p1'] }]) {
    await assert.rejects(
      as(ctx, () => svc.forDeploy('u1', 'c1')),
      (e: any) => e instanceof ForbiddenException && /organization-level credential/.test(e.message)
    );
  }
});

test('connection lookups refuse org-scoped credentials, normal sessions pass', async () => {
  const svc = connections();
  await assert.rejects(
    as({ sessionOrgId: ORG }, () => (svc as any).rowOrThrow('u1', 'c1')),
    ForbiddenException
  );
  assert.equal((await as({}, () => svc.forDeploy('u1', 'c1'))).id, 'c1');
  assert.equal((await as(undefined, () => svc.forDeploy('u1', 'c1'))).id, 'c1');
});

test('compose from-github refuses a private repo for an org-scoped credential', async () => {
  const f = stubFetch();
  try {
    const github = githubService();
    const svc = Object.create(ComposeStacksService.prototype) as any;
    svc.github = github;
    await assert.rejects(
      as({ sessionOrgId: ORG }, () =>
        svc.fetchComposeFromGithub('u1', 'https://github.com/a/b', 'main', 'compose.yml')
      ),
      (e: any) => e instanceof ForbiddenException && /organization-level credential/.test(e.message)
    );
  } finally {
    f.restore();
  }
});
