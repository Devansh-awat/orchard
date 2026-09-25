import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentsService } from '../src/projects/deployments.service';
import { GitConnectionsService } from '../src/git/git-connections.service';

const OWNER = 'user-owner';
const OTHER = 'user-other';

function harness(caller: string) {
  const updates: unknown[] = [];
  const connection = {
    id: 'conn-1',
    name: 'Codeberg',
    baseUrl: 'https://codeberg.org',
    userId: OWNER
  };
  const deployment = {
    id: 'dep-1',
    name: 'web',
    projectId: 'proj-1',
    project: { id: 'proj-1', organizationId: 'org-1' },
    githubRepo: 'https://codeberg.org/team/app',
    githubBranch: 'main',
    dockerfilePath: 'Dockerfile',
    buildType: 'dockerfile',
    gitConnectionId: 'conn-1',
    autoDeployEnabled: true,
    autoDeployBranch: 'main'
  };
  const connections = Object.create(GitConnectionsService.prototype) as GitConnectionsService;
  Object.assign(connections, { registerWebhook: async () => ({ status: 'registered' }) });
  const svc = Object.create(DeploymentsService.prototype) as DeploymentsService;
  Object.assign(svc, {
    usersService: { findOrCreateByClerkId: async () => ({ id: caller, email: `${caller}@x` }) },
    prisma: {
      deployment: {
        findUnique: async () => deployment,
        update: async (args: unknown) => {
          updates.push(args);
          return deployment;
        }
      },
      gitConnection: { findUnique: async () => connection }
    },
    authz: { requireProjectEdit: async () => {} },
    gitConnections: connections,
    audit: { log: async () => {} },
    getDeployment: async () => ({ ok: true })
  });
  return { svc, updates };
}

test('a project editor who did not link the provider cannot repoint its app', async () => {
  const { svc, updates } = harness(OTHER);
  await assert.rejects(
    svc.updateDeploymentGitHubRepo(
      'dep-1',
      { repoUrl: 'https://codeberg.org/team/other', branch: 'main' },
      'clerk'
    ),
    /Only the person who linked/
  );
  assert.equal(updates.length, 0);
});

test('the owner cannot aim the provider at a different host', async () => {
  const { svc, updates } = harness(OWNER);
  await assert.rejects(
    svc.updateDeploymentGitHubRepo(
      'dep-1',
      { repoUrl: 'https://gitlab.com/team/app', branch: 'main' },
      'clerk'
    ),
    /is for codeberg\.org/
  );
  assert.equal(updates.length, 0);
});

test('the owner can move the app within the host, and the repo id is forgotten', async () => {
  const { svc, updates } = harness(OWNER);
  await svc.updateDeploymentGitHubRepo(
    'dep-1',
    { repoUrl: 'https://codeberg.org/team/other', branch: 'dev' },
    'clerk'
  );
  assert.equal(updates.length, 1);
  const data = (updates[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.githubRepo, 'https://codeberg.org/team/other');
  assert.equal(data.githubBranch, 'dev');
  assert.equal(data.externalRepoId, null);
  assert.equal(data.autoDeployBranch, 'dev');
});
