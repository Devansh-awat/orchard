import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/github/github.service';
import { RepoFilesService } from '../src/git/repo-files.service';
import { submoduleRepos } from '../src/github/submodules';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

const INSTALL = 42n;

function harness(
  opts: {
    userSees?: string[];
    gitmodules?: Record<string, string>;
    installationSees?: string[];
    failMintWhenMoreThanOne?: boolean;
  } = {}
) {
  const minted: string[][] = [];
  const verified: Array<[string, string]> = [];
  const svc = new GitHubService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new SecretCryptoService()
  );
  Object.assign(svc, {
    findInstallationForRepo: async () => ({ installationId: INSTALL }),
    getOrRefreshInstallationToken: async () => 'whole-installation',
    verifyUserCanAccessRepo: async (userId: string, _owner: string, repo: string) => {
      verified.push([userId, repo]);
      return (opts.userSees ?? []).includes(repo);
    },
    isRepoAccessibleByInstallation: async (_id: bigint, _owner: string, repo: string) =>
      opts.installationSees ? opts.installationSees.includes(repo) : true,
    getFileContent: async (_token: string, _owner: string, repo: string) => {
      const file = opts.gitmodules?.[repo];
      if (file === undefined) throw new Error('not found');
      return file;
    },
    getInstallationAccessToken: async (_id: bigint, repos?: string[]) => {
      if (opts.failMintWhenMoreThanOne && (repos?.length ?? 0) > 1) throw new Error('422');
      minted.push(repos ?? []);
      return { token: `scoped:${(repos ?? ['ALL']).join(',')}`, expiresAt: new Date() };
    }
  });
  const access = (input: { bound?: bigint | null; linkedBy?: string | null } = {}) =>
    svc.resolveCloneAccess({
      owner: 'acme',
      repo: 'app',
      branch: 'main',
      boundInstallationId: input.bound === undefined ? INSTALL : input.bound,
      linkedBy: input.linkedBy === undefined ? 'linker' : input.linkedBy
    });
  return { svc, access, minted, verified };
}

const module = (url: string) => `[submodule "x"]\n\tpath = x\n\turl = ${url}\n`;

test('submodule URLs resolve the way git resolves them, and only same-owner repos count', () => {
  const names = (url: string) => submoduleRepos(module(url), 'acme', 'app');
  assert.deepEqual(names('https://github.com/acme/secret.git'), ['secret']);
  assert.deepEqual(names('https://GitHub.com/ACME/secret'), ['secret']);
  assert.deepEqual(names('../secret.git'), ['secret']);
  assert.deepEqual(names('../../acme/secret'), ['secret']);
  assert.deepEqual(names('"../secret.git"'), ['secret']);
  assert.deepEqual(names('https://github.com/other/secret'), []);
  assert.deepEqual(names('../../other/secret'), []);
  assert.deepEqual(names('./nested'), []);
  assert.deepEqual(names('https://evil.example/acme/secret'), []);
  assert.deepEqual(names('git@github.com:acme/secret.git'), []);
  assert.deepEqual(names('https://github.com/acme/..'), []);
  assert.deepEqual(
    submoduleRepos(`${module('../a')}${module('../a.git')}${module('../b')}`, 'acme', 'app'),
    ['a', 'b']
  );
});

test('a clone token covers only the app repo, and only reads contents', async () => {
  const { access, minted } = harness();
  const result = await access();
  assert.deepEqual(minted, [['app']]);
  assert.equal(result?.token, 'scoped:app');
  assert.notEqual(result?.token, 'whole-installation');
});

test('the token request names the repos and asks for read access only', async () => {
  const svc = new GitHubService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new SecretCryptoService()
  );
  Object.assign(svc, { generateAppJwt: () => 'jwt' });
  const realFetch = globalThis.fetch;
  let sent: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ token: 't', expires_at: new Date().toISOString() }));
  }) as any;
  try {
    await svc.getInstallationAccessToken(INSTALL, ['app', 'lib']);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, { repositories: ['app', 'lib'], permissions: { contents: 'read' } });
});

test('a submodule the linker cannot see stays out of the token', async () => {
  const { access, minted } = harness({
    gitmodules: { app: module('https://github.com/acme/secret') }
  });
  await access();
  assert.deepEqual(minted, [['app']]);
});

test('a submodule the linker can see goes into the token', async () => {
  const { access, minted, verified } = harness({
    userSees: ['lib'],
    gitmodules: { app: module('../lib.git') }
  });
  await access();
  assert.deepEqual(minted, [['app', 'lib']]);
  assert.deepEqual(verified, [['linker', 'lib']]);
});

test('a submodule the App cannot see stays out, whatever the linker can see', async () => {
  const { access, minted } = harness({
    userSees: ['lib'],
    installationSees: [],
    gitmodules: { app: module('../lib.git') }
  });
  await access();
  assert.deepEqual(minted, [['app']]);
});

test('nested submodules are checked too, and a repo that cannot be reached stops the walk', async () => {
  const { access, minted } = harness({
    userSees: ['lib', 'deep'],
    gitmodules: {
      app: module('../lib.git'),
      lib: `${module('../deep')}${module('../secret')}`,
      deep: module('../app'),
      secret: module('../other-secret')
    }
  });
  await access();
  assert.deepEqual(minted, [['app', 'lib', 'deep']]);
});

test('a .gitmodules full of guesses only costs a bounded number of checks', async () => {
  const guesses = Array.from({ length: 8000 }, (_, i) => module(`../guess-${i}`)).join('');
  const { access, minted, verified } = harness({ gitmodules: { app: guesses } });
  await access();
  assert.equal(verified.length, 25);
  assert.deepEqual(minted, [['app']]);
});

test('with no linker on record, no private submodule gets in', async () => {
  const { access, minted } = harness({ gitmodules: { app: module('../lib.git') } });
  await access({ linkedBy: null });
  assert.deepEqual(minted, [['app']]);
});

test('a token that cannot include a submodule falls back to the app repo alone', async () => {
  const { access, minted } = harness({
    userSees: ['renamed'],
    gitmodules: { app: module('../renamed') },
    failMintWhenMoreThanOne: true
  });
  const result = await access();
  assert.deepEqual(minted, [['app']]);
  assert.equal(result?.token, 'scoped:app');
});

test('an app linked while its repo was public gets no token once nobody vouches for it', async () => {
  const { access, minted } = harness();
  assert.equal(await access({ bound: null }), null);
  assert.deepEqual(minted, []);
});

test('an unbound app whose linker can see the repo gets its token', async () => {
  const { access } = harness({ userSees: ['app'] });
  assert.equal((await access({ bound: null }))?.installationId, INSTALL);
});

test('a binding to a different installation is not trusted', async () => {
  const { access } = harness();
  assert.equal(await access({ bound: 7n }), null);
});

test('with no linker and no binding nothing is granted', async () => {
  const { access } = harness({ userSees: ['app'] });
  assert.equal(await access({ bound: null, linkedBy: null }), null);
});

function repoFiles(githubInstallationId: bigint | null) {
  const calls: string[] = [];
  const service = new RepoFilesService(
    {
      deployment: {
        findUnique: async () => ({
          githubRepo: 'https://github.com/acme/app',
          githubBranch: 'main',
          autoDeployBranch: null,
          gitConnectionId: null,
          githubInstallationId,
          createdBy: 'creator'
        })
      }
    } as any,
    {
      parseRepoUrl: () => ({ owner: 'acme', repo: 'app' }),
      resolveRepoToken: async () => {
        calls.push('app');
        return 'app-token';
      },
      getValidUserToken: async () => {
        calls.push('user');
        return 'user-token';
      },
      getFileContent: async (token: string) => token
    } as any,
    {} as any
  );
  return { service, calls };
}

test('file reads use the App only for an app that was linked with access', async () => {
  const bound = repoFiles(INSTALL);
  const unbound = repoFiles(null);
  assert.equal(await (await bound.service.readerForDeployment('d'))!('score.yaml'), 'app-token');
  assert.equal(await (await unbound.service.readerForDeployment('d'))!('score.yaml'), 'user-token');
  assert.deepEqual(unbound.calls, ['user']);
});
