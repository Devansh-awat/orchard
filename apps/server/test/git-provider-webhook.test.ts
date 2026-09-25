import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { GitWebhookController } from '../src/git/git-webhook.controller';
import { GitConnectionsService } from '../src/git/git-connections.service';
import { providerFor } from '../src/git/providers';
import { encodeCloneCredential } from '../src/git/clone-credential';
import { withCloneCredentials, parseRepoUrl } from '../src/docker/repo-url';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const connections = {
  A: {
    id: 'conn-a',
    provider: 'gitea',
    baseUrl: 'https://codeberg.org',
    username: null,
    token: 'tok-a',
    webhookSecret: 'secret-a'
  },
  B: {
    id: 'conn-b',
    provider: 'gitea',
    baseUrl: 'https://codeberg.org',
    username: null,
    token: 'tok-b',
    webhookSecret: 'secret-b'
  }
};

const deployments = [
  {
    id: 'dep-a',
    name: 'a',
    gitConnectionId: 'conn-a',
    githubRepo: 'https://codeberg.org/team/app',
    externalRepoId: null,
    autoDeployEnabled: true,
    autoDeployBranch: 'main',
    githubBranch: 'main',
    autoDeployPaths: []
  },
  {
    id: 'dep-b',
    name: 'b',
    gitConnectionId: 'conn-b',
    githubRepo: 'https://codeberg.org/team/app',
    externalRepoId: null,
    autoDeployEnabled: true,
    autoDeployBranch: 'main',
    githubBranch: 'main',
    autoDeployPaths: []
  }
];

function harness() {
  const triggered: string[] = [];
  const adopted: { ids: string[]; externalRepoId: string }[] = [];
  const prisma = {
    gitConnection: {
      findUnique: async ({ where }: any) =>
        Object.values(connections).find((c) => c.id === where.id) ?? null
    },
    deployment: {
      findMany: async ({ where }: any) =>
        deployments.filter(
          (d) => d.gitConnectionId === where.gitConnectionId && d.autoDeployEnabled
        ),
      updateMany: async ({ where, data }: any) => {
        adopted.push({ ids: where.id.in, externalRepoId: data.externalRepoId });
        return { count: where.id.in.length };
      }
    }
  };
  const svc = Object.create(GitConnectionsService.prototype) as GitConnectionsService;
  Object.assign(svc, {
    crypto: { decrypt: (v: string) => v },
    providerForRow: (row: any) =>
      providerFor({
        kind: row.provider,
        baseUrl: row.baseUrl,
        username: row.username,
        token: row.token,
        webhookSecret: row.webhookSecret
      })
  });
  const ctl = new GitWebhookController(prisma as any, svc, {
    triggerAutoDeploy: async (id: string) => {
      triggered.push(id);
    }
  } as any);
  return { ctl, triggered, adopted };
}

const push = {
  ref: 'refs/heads/main',
  before: '1111111111111111111111111111111111111111',
  after: SHA,
  repository: { id: 7, full_name: 'team/app', html_url: 'https://codeberg.org/team/app' },
  head_commit: { id: SHA, message: 'feat: x', author: { name: 'Leaf', username: 'leafd' } },
  commits: []
};

function deliver(ctl: GitWebhookController, connectionId: string, secret: string) {
  const raw = JSON.stringify(push);
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  return ctl.receive(
    connectionId,
    { 'x-gitea-event': 'push', 'x-gitea-signature': sig },
    { rawBody: Buffer.from(raw) } as any,
    push
  );
}

test("a push signed with connection A's secret only ever reaches connection A's deployments", async () => {
  const { ctl, triggered } = harness();
  const res = await deliver(ctl, 'conn-a', 'secret-a');
  assert.equal(res.action, 'deploying');
  assert.deepEqual(triggered, ['dep-a']);
});

test("connection A's secret cannot trigger connection B, even for the same repo", async () => {
  const { ctl, triggered } = harness();
  await assert.rejects(deliver(ctl, 'conn-b', 'secret-a'), /Invalid signature/);
  assert.deepEqual(triggered, []);
});

test('a delivery for an unknown connection is refused before anything is parsed', async () => {
  const { ctl, triggered } = harness();
  await assert.rejects(deliver(ctl, 'conn-nope', 'secret-a'), /Unknown webhook/);
  assert.deepEqual(triggered, []);
});

test('a matched push records the repo id so a rename cannot detach the app', async () => {
  const { ctl, adopted } = harness();
  await deliver(ctl, 'conn-a', 'secret-a');
  assert.deepEqual(adopted, [{ ids: ['dep-a'], externalRepoId: '7' }]);
});

test('a connection credential is pinned to its own host', () => {
  const token = encodeCloneCredential({ host: 'codeberg.org', username: 'git', password: 'p@ss' });
  const own = withCloneCredentials(parseRepoUrl('https://codeberg.org/team/app')!, token);
  assert.equal(own, 'https://git:p%40ss@codeberg.org/team/app');
  for (const stranger of [
    'https://codeberg.org.evil.com/team/app',
    'https://github.com/team/app',
    'https://evil.com/codeberg.org/team/app'
  ]) {
    assert.equal(withCloneCredentials(parseRepoUrl(stranger)!, token), stranger);
  }
  assert.equal(
    withCloneCredentials(parseRepoUrl('https://github.com/o/r')!, 'ghs_abc'),
    'https://x-access-token:ghs_abc@github.com/o/r'
  );
  assert.equal(
    withCloneCredentials(parseRepoUrl('https://gitlab.com/o/r')!, 'ghs_abc'),
    'https://gitlab.com/o/r'
  );
});
