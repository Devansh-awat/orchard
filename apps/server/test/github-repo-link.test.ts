import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testPrismaClient } from './support/test-database';
import { GitHubService } from '../src/github/github.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

const prisma = testPrismaClient();

const SLUG = 'test-repo-link-org';
const NS = 'test-repo-link-ns';
const INSTALLATION_ID = 987654321n;
const OTHER_INSTALLATION_ID = 987654322n;
const REPO_ID = 1226938832n;
const OLD_NAME = 'hackclub/hack-club-videos';
const NEW_NAME = 'hackclub/unified-posts-db';

let projectId = '';
let installationRowId = '';

/** Constructed by hand: the reconcile paths only need prisma, and leadership is assumed. */
function newService(): GitHubService {
  return new GitHubService(
    prisma as never,
    {} as never,
    {} as never,
    {
      isLeader: () => true,
      onAcquired: () => {}
    } as never,
    new SecretCryptoService()
  );
}

async function makeDeployment(over: {
  name: string;
  githubRepo: string | null;
  githubRepoId?: bigint | null;
  githubInstallationId?: bigint | null;
  autoDeployEnabled?: boolean;
}) {
  return prisma.deployment.create({
    data: {
      projectId,
      namespace: NS,
      githubBranch: 'main',
      autoDeployEnabled: over.autoDeployEnabled ?? true,
      githubInstallationId: over.githubInstallationId ?? INSTALLATION_ID,
      githubRepoId: over.githubRepoId ?? null,
      name: over.name,
      githubRepo: over.githubRepo
    }
  });
}

async function reload(id: string) {
  return prisma.deployment.findUniqueOrThrow({
    where: { id },
    select: { githubRepo: true, githubRepoId: true }
  });
}

async function cleanup() {
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (org) await prisma.organization.delete({ where: { id: org.id } });
  await prisma.gitHubAppInstallation.deleteMany({
    where: { installationId: { in: [INSTALLATION_ID, OTHER_INSTALLATION_ID] } }
  });
}

before(async () => {
  await cleanup();
  const org = await prisma.organization.create({ data: { name: 'Repo Link Org', slug: SLUG } });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: 'repolink', slug: 'repolink', namespace: NS }
  });
  projectId = project.id;
  const inst = await prisma.gitHubAppInstallation.create({
    data: {
      installationId: INSTALLATION_ID,
      accountLogin: 'hackclub',
      accountId: 1n,
      accountType: 'Organization'
    }
  });
  installationRowId = inst.id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.deployment.deleteMany({ where: { projectId } });
  await prisma.gitHubRepoMirror.deleteMany({ where: { appInstallationId: installationRowId } });
});

test('a push matches a deployment by repository id, whatever the repo is called now', async () => {
  // The row still says hack-club-videos because that is what it was called when
  // it was linked. The push arrives as unified-posts-db.
  const dep = await makeDeployment({
    name: 'renamed-under-us',
    githubRepo: `https://github.com/${OLD_NAME}`,
    githubRepoId: REPO_ID
  });

  const matched = await newService().findAutoDeployTargets(INSTALLATION_ID, REPO_ID, NEW_NAME);

  assert.deepEqual(
    matched.map((d) => d.id),
    [dep.id]
  );
  // and the row is brought up to date on the way past
  assert.equal((await reload(dep.id)).githubRepo, `https://github.com/${NEW_NAME}`);
});

test('a push still matches an unlinked row by url, and records the id for next time', async () => {
  const dep = await makeDeployment({
    name: 'legacy-row',
    githubRepo: `https://github.com/${NEW_NAME}`
  });

  const matched = await newService().findAutoDeployTargets(INSTALLATION_ID, REPO_ID, NEW_NAME);

  assert.deepEqual(
    matched.map((d) => d.id),
    [dep.id]
  );
  assert.equal((await reload(dep.id)).githubRepoId, REPO_ID);
});

test('adoption leaves a legacy .git suffix alone', async () => {
  const dep = await makeDeployment({
    name: 'dot-git-row',
    githubRepo: `https://github.com/${OLD_NAME}.git`,
    githubRepoId: REPO_ID
  });

  await newService().findAutoDeployTargets(INSTALLATION_ID, REPO_ID, NEW_NAME);

  assert.equal((await reload(dep.id)).githubRepo, `https://github.com/${NEW_NAME}.git`);
});

test('a repository id from another installation claims nothing', async () => {
  await makeDeployment({
    name: 'someone-elses',
    githubRepo: `https://github.com/${NEW_NAME}`,
    githubRepoId: REPO_ID
  });

  const matched = await newService().findAutoDeployTargets(
    OTHER_INSTALLATION_ID,
    REPO_ID,
    NEW_NAME
  );

  assert.deepEqual(matched, []);
});

test('a disabled deployment is never a target', async () => {
  await makeDeployment({
    name: 'auto-deploy-off',
    githubRepo: `https://github.com/${NEW_NAME}`,
    githubRepoId: REPO_ID,
    autoDeployEnabled: false
  });

  assert.deepEqual(
    await newService().findAutoDeployTargets(INSTALLATION_ID, REPO_ID, NEW_NAME),
    []
  );
});

test('a rename event relinks rows that predate the repository id', async () => {
  const dep = await makeDeployment({
    name: 'pre-id',
    githubRepo: `https://github.com/${OLD_NAME}`
  });

  await newService().applyRepositoryEvent(
    INSTALLATION_ID,
    'renamed',
    { id: Number(REPO_ID), full_name: NEW_NAME, private: false, default_branch: 'main' },
    OLD_NAME
  );

  const row = await reload(dep.id);
  assert.equal(row.githubRepoId, REPO_ID);
  assert.equal(row.githubRepo, `https://github.com/${NEW_NAME}`);
});

test('the reconciler links a row from the installation mirror without asking github', async () => {
  const dep = await makeDeployment({
    name: 'mirrored',
    githubRepo: `https://github.com/${NEW_NAME}`
  });
  await prisma.gitHubRepoMirror.create({
    data: { appInstallationId: installationRowId, githubRepoId: REPO_ID, fullName: NEW_NAME }
  });

  const service = newService();
  (service as any).getOrRefreshInstallationToken = async () => {
    throw new Error('the mirror already knew this one');
  };

  assert.equal(await service.reconcileRepoLinks(), 1);
  assert.equal((await reload(dep.id)).githubRepoId, REPO_ID);
});

test('the reconciler recovers a row whose repo was renamed before anyone was watching', async () => {
  // Exactly the reported failure: nothing in Orchard knows the new name, the
  // mirror only holds it under the new one, and the row is still on the old.
  const dep = await makeDeployment({
    name: 'drifted',
    githubRepo: `https://github.com/${OLD_NAME}`
  });

  const service = newService();
  (service as any).getOrRefreshInstallationToken = async () => 'token';
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: any) => {
    asked.push(String(url));
    return {
      ok: true,
      json: async () => ({ id: Number(REPO_ID), full_name: NEW_NAME })
    };
  }) as never;

  try {
    assert.equal(await service.reconcileRepoLinks(), 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(asked, [`https://api.github.com/repos/${OLD_NAME}`]);
  const row = await reload(dep.id);
  assert.equal(row.githubRepoId, REPO_ID, 'linked by id');
  assert.equal(row.githubRepo, `https://github.com/${NEW_NAME}`, 'and moved to the current name');

  // Which is the point: the next push now finds it.
  const matched = await service.findAutoDeployTargets(INSTALLATION_ID, REPO_ID, NEW_NAME);
  assert.deepEqual(
    matched.map((d) => d.id),
    [dep.id]
  );
});

test('one lookup serves every deployment built from the same repo', async () => {
  await makeDeployment({ name: 'sibling-a', githubRepo: `https://github.com/${OLD_NAME}` });
  await makeDeployment({ name: 'sibling-b', githubRepo: `https://github.com/${OLD_NAME}` });
  await makeDeployment({ name: 'sibling-c', githubRepo: `https://github.com/${OLD_NAME}.git` });

  const service = newService();
  (service as any).getOrRefreshInstallationToken = async () => 'token';
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, json: async () => ({ id: Number(REPO_ID), full_name: NEW_NAME }) };
  }) as never;

  try {
    assert.equal(await service.reconcileRepoLinks(), 3);
  } finally {
    globalThis.fetch = realFetch;
  }

  // The .git row is a different stored string but the same repository, so it
  // shares the lookup rather than paying for its own.
  assert.equal(calls, 1);
  assert.equal(await prisma.deployment.count({ where: { projectId, githubRepoId: REPO_ID } }), 3);
});

test('a repo github no longer answers for is left alone rather than unlinked', async () => {
  const dep = await makeDeployment({ name: 'gone', githubRepo: `https://github.com/${OLD_NAME}` });

  const service = newService();
  (service as any).getOrRefreshInstallationToken = async () => 'token';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as never;

  try {
    assert.equal(await service.reconcileRepoLinks(), 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  const row = await reload(dep.id);
  assert.equal(row.githubRepoId, null);
  assert.equal(row.githubRepo, `https://github.com/${OLD_NAME}`);
});
