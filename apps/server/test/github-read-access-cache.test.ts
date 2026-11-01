import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/github/github.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

function harness(opts: { userCan: boolean; installation: bigint | null; isPublic?: boolean }) {
  const counts = { verify: 0, find: 0, mint: 0, user: 0, pub: 0 };
  const svc = new GitHubService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new SecretCryptoService()
  );
  Object.assign(svc, {
    verifyUserCanAccessRepo: async () => {
      counts.verify += 1;
      return opts.userCan;
    },
    findInstallationForRepo: async () => {
      counts.find += 1;
      return opts.installation ? { installationId: opts.installation } : null;
    },
    getOrRefreshInstallationToken: async (id: bigint) => {
      counts.mint += 1;
      return `inst-${id}`;
    },
    getValidUserToken: async () => {
      counts.user += 1;
      return 'user-token';
    },
    isRepoPublic: async () => {
      counts.pub += 1;
      return opts.isPublic ?? false;
    }
  });
  return { svc, counts };
}

const user = { id: 'u1', githubAccessToken: 'enc' };

test('a granted repo resolves once, then reuses the decision and only re-reads the token', async () => {
  const { svc, counts } = harness({ userCan: true, installation: 42n });
  assert.equal(await svc.resolveReadAccessToken(user, 'Acme', 'Site'), 'inst-42');
  assert.equal(await svc.resolveReadAccessToken(user, 'acme', 'site'), 'inst-42');
  assert.equal(counts.verify, 1);
  assert.equal(counts.find, 1);
  assert.equal(counts.mint, 2);
});

test('a denied repo is never cached, so access granted a second later works', async () => {
  const h = harness({ userCan: false, installation: null });
  assert.equal(await h.svc.resolveReadAccessToken(user, 'acme', 'private'), null);
  assert.equal(await h.svc.resolveReadAccessToken(user, 'acme', 'private'), null);
  assert.equal(h.counts.verify, 2);
  assert.equal(h.counts.pub, 2);
});

test('installation changes invalidate cached decisions', async () => {
  const { svc, counts } = harness({ userCan: true, installation: 7n });
  await svc.resolveReadAccessToken(user, 'acme', 'site');
  svc.clearUserInstallationsCache();
  await new Promise((r) => setTimeout(r, 5));
  await svc.resolveReadAccessToken(user, 'acme', 'site');
  assert.equal(counts.verify, 2);
});

test('a public repo without a linked account resolves to an anonymous token', async () => {
  const { svc } = harness({ userCan: false, installation: null, isPublic: true });
  assert.equal(
    await svc.resolveReadAccessToken({ id: 'u2', githubAccessToken: null }, 'a', 'b'),
    ''
  );
  assert.equal(
    await svc.resolveReadAccessToken({ id: 'u2', githubAccessToken: null }, 'a', 'b'),
    ''
  );
});

test('falls back to the user token when the installation token cannot be minted', async () => {
  const { svc } = harness({ userCan: true, installation: 9n });
  Object.assign(svc, {
    getOrRefreshInstallationToken: async () => {
      throw new Error('revoked');
    }
  });
  assert.equal(await svc.resolveReadAccessToken(user, 'acme', 'site'), 'user-token');
});

test('unlinking github forgets that user without touching anyone else', async () => {
  const { svc, counts } = harness({ userCan: true, installation: 7n });
  Object.assign(svc, { prisma: { user: { update: async () => ({}) } } });
  const other = { id: 'u9', githubAccessToken: 'enc' };
  await svc.resolveReadAccessToken(user, 'acme', 'site');
  await svc.resolveReadAccessToken(other, 'acme', 'site');
  await new Promise((r) => setTimeout(r, 5));
  await svc.unlinkGitHubAccount(user.id);
  await svc.resolveReadAccessToken(user, 'acme', 'site');
  await svc.resolveReadAccessToken(other, 'acme', 'site');
  assert.equal(counts.verify, 3);
});
