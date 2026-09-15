import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/github/github.service';

interface FetchCall {
  url: string;
  init?: any;
}

function stubFetch(handler: (url: string) => { status?: number; body?: any; link?: string }) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body = {}, link = '' } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h.toLowerCase() === 'link' ? link : null) },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    } as any;
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function makeService(overrides: Partial<Record<string, any>> = {}) {
  const svc = new GitHubService({} as any, {} as any);
  Object.assign(svc, overrides);
  return svc;
}

const MIRROR_ROWS = [
  {
    appInstallationId: 'inst-a',
    githubRepoId: 1n,
    fullName: 'acme/public-site',
    private: false,
    defaultBranch: 'main',
    pushedAt: null,
    syncedAt: new Date()
  },
  {
    appInstallationId: 'inst-a',
    githubRepoId: 2n,
    fullName: 'acme/payroll-secrets',
    private: true,
    defaultBranch: 'main',
    pushedAt: null,
    syncedAt: new Date()
  },
  {
    appInstallationId: 'inst-a',
    githubRepoId: 3n,
    fullName: 'acme/infra-private',
    private: true,
    defaultBranch: 'main',
    pushedAt: null,
    syncedAt: new Date()
  }
];

function serviceWithMirror(extra: Record<string, any> = {}) {
  return makeService({
    prisma: { gitHubRepoMirror: { findMany: async () => MIRROR_ROWS } },
    getUserInstallations: async () => [
      { id: 'inst-a', installationId: 42n, accountLogin: 'acme', accountType: 'Organization' }
    ],
    getValidUserToken: async () => 'user-token',
    ...extra
  });
}

test('repo list only returns repos the user can access through the installation', async () => {
  // The installation covers three repos; GitHub says this user can see one.
  const { restore } = stubFetch(() => ({ body: { repositories: [{ id: 1 }] } }));
  try {
    const svc = serviceWithMirror();
    const { repos, installations } = await svc.getAllUserRepositories('user-1');

    assert.deepEqual(
      repos.map((r: any) => r.full_name),
      ['acme/public-site']
    );
    assert.equal(installations[0].repositoryCount, 1);
  } finally {
    restore();
  }
});

test('repo list fails closed when the accessible-repo lookup errors', async () => {
  const { restore } = stubFetch(() => ({ status: 500 }));
  try {
    const svc = serviceWithMirror();
    const { repos } = await svc.getAllUserRepositories('user-1');
    assert.deepEqual(repos, []);
  } finally {
    restore();
  }
});

test('repo list is empty when the user has no linked GitHub token', async () => {
  const svc = serviceWithMirror({ getValidUserToken: async () => null });
  const { repos, userLinked, hasInstallations } = await svc.getAllUserRepositories('user-1');
  assert.deepEqual(repos, []);
  assert.equal(userLinked, false);
  assert.equal(hasInstallations, true);
});

test('accessible-repo lookup is user-scoped, not installation-scoped', async () => {
  const { calls, restore } = stubFetch(() => ({ body: { repositories: [] } }));
  try {
    const svc = serviceWithMirror();
    await svc.getAllUserRepositories('user-1');
    assert.ok(
      calls.every((c) => !c.url.includes('/installation/repositories')),
      'must not seed the list from the installation-wide endpoint'
    );
    assert.ok(
      calls.some((c) => c.url.includes('/user/installations/42/repositories')),
      'must intersect against the user-to-server endpoint'
    );
  } finally {
    restore();
  }
});

const TRAVERSALS = [
  '../../../victim/private/contents/README.md',
  '../../../../installation/repositories',
  'ok/../../escape',
  '..',
  './../secrets'
];

test('getFileContent rejects paths that escape the authorized repo', async () => {
  const { calls, restore } = stubFetch(() => ({ body: 'contents' }));
  try {
    const svc = makeService();
    for (const path of TRAVERSALS) {
      await assert.rejects(
        () => svc.getFileContent('token', 'attacker', 'own-repo', path),
        /Invalid file path/,
        `expected ${path} to be rejected`
      );
    }
    assert.equal(calls.length, 0, 'no request should reach GitHub');
  } finally {
    restore();
  }
});

test('getRepoContents rejects paths that escape the authorized repo', async () => {
  const { calls, restore } = stubFetch(() => ({ body: [] }));
  try {
    const svc = makeService();
    for (const path of TRAVERSALS) {
      await assert.rejects(
        () => svc.getRepoContents('token', 'attacker', 'own-repo', path),
        /Invalid file path/
      );
    }
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('legitimate nested paths still resolve inside the authorized repo', async () => {
  const { calls, restore } = stubFetch(() => ({ body: 'yaml' }));
  try {
    const svc = makeService();
    await svc.getFileContent('token', 'acme', 'app', 'deploy/stacks/docker-compose.yml', 'main');
    assert.equal(
      calls[0].url,
      'https://api.github.com/repos/acme/app/contents/deploy/stacks/docker-compose.yml?ref=main'
    );
  } finally {
    restore();
  }
});

test('percent-encoded traversal in owner/repo cannot escape either', async () => {
  const { calls, restore } = stubFetch(() => ({ body: 'x' }));
  try {
    const svc = makeService();
    await svc.getFileContent('token', 'acme/../..', 'app', 'README.md');
    const resolved = new URL(calls[0].url);
    assert.ok(
      resolved.pathname.startsWith('/repos/acme%2F..%2F../app/'),
      `owner segment must stay encoded, got ${resolved.pathname}`
    );
  } finally {
    restore();
  }
});
