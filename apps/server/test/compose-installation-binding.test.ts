import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposeStacksService } from '../src/compose-stacks/compose-stacks.service';

function harness(opts: { maintains?: boolean; installation?: bigint | null }) {
  const lookups: [string, string][] = [];
  const service = Object.create(ComposeStacksService.prototype) as any;
  service.prisma = {
    gitHubAppInstallation: {
      findMany: async () => [{ installationId: 1n }]
    }
  };
  service.github = {
    parseRepoUrl: () => ({ owner: 'acme', repo: 'app' }),
    verifyUserCanAccessRepo: async () => true,
    userMaintainsRepo: async () => opts.maintains ?? true,
    isRepoPublic: async () => false,
    resolveRepoToken: async () => 'tok',
    getFileContent: async () => 'services: {}',
    findInstallationForRepo: async (owner: string, repo: string) => {
      lookups.push([owner, repo]);
      return opts.installation === null ? null : { installationId: opts.installation ?? 42n };
    }
  };
  return { service, lookups };
}

test('the stack binds to the installation that covers the repo, not the first one', async () => {
  const { service, lookups } = harness({ installation: 42n });
  const out = await service.fetchComposeFromGithub(
    'u1',
    'https://github.com/acme/app',
    'main',
    'c.yml'
  );
  assert.equal(out.installationId, 42n);
  assert.deepEqual(lookups, [['acme', 'app']]);
});

test('no covering installation leaves the stack unbound', async () => {
  const { service } = harness({ installation: null });
  const out = await service.fetchComposeFromGithub(
    'u1',
    'https://github.com/acme/app',
    'main',
    'c.yml'
  );
  assert.equal(out.installationId, null);
});

test('a user who does not maintain the repo gets no installation binding', async () => {
  const { service, lookups } = harness({ maintains: false });
  const out = await service.fetchComposeFromGithub(
    'u1',
    'https://github.com/acme/app',
    'main',
    'c.yml'
  );
  assert.equal(out.installationId, null);
  assert.deepEqual(lookups, []);
});
