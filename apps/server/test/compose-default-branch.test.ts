import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposeStacksService } from '../src/compose-stacks/compose-stacks.service';

function harness(branchFromGitHub = 'master') {
  const created: any[] = [];
  const service = Object.create(ComposeStacksService.prototype) as any;
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'user' }) };
  service.authz = { requireProjectEdit: async () => ({}) };
  service.environments = { resolveEnvironment: async () => ({ id: 'env' }) };
  service.github = {
    parseRepoUrl: () => ({ owner: 'docker', repo: 'awesome-compose' }),
    resolveRepoToken: async () => null,
    getDefaultBranch: async () => branchFromGitHub
  };
  service.deployments = { assertEnvironmentVolumesUnclaimed: async () => undefined };
  service.prisma = {
    composeStack: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'stack', ...data };
      },
      update: async () => ({})
    }
  };
  service.fetchComposeFromGithub = async (_u: string, _r: string, branch: string) => {
    created.push({ fetchedBranch: branch });
    return { composeYaml: 'services:\n  web:\n    image: nginx\n', installationId: null };
  };
  service.deployChildren = async () => undefined;
  service.getComposeStack = async () => ({ id: 'stack' });
  return { service, created };
}

test('a stack with no branch uses the default branch GitHub reports', async () => {
  const { service, created } = harness();
  await service.createFromGithub(
    'project',
    { name: 'app', repoUrl: 'https://github.com/docker/awesome-compose' },
    'clerk'
  );
  assert.equal(created[0].fetchedBranch, 'master');
  assert.equal(created[1].githubBranch, 'master');
});

test('a branch the caller named is left alone', async () => {
  const { service, created } = harness();
  await service.createFromGithub(
    'project',
    { name: 'app', repoUrl: 'https://github.com/docker/awesome-compose', branch: 'dev' },
    'clerk'
  );
  assert.equal(created[1].githubBranch, 'dev');
});
