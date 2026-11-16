import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { WebhooksController } from '../src/webhooks/webhooks.controller';
import { AuditService } from '../src/audit/audit.service';
import { IS_PUBLIC_KEY } from '../src/auth/decorators';
import { PRINCIPAL_THROTTLER } from '../src/auth/api-throttler.guard';
import { BODY_TIER_LIMITS, bodyTierFor } from '../src/http/body-limits';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const REGISTRY = 'registry.example.com';
process.env.DOCKER_REGISTRY_PULL = REGISTRY;
process.env.DOCKER_REGISTRY_PUSH = REGISTRY;
process.env.REGISTRY_PROJECT = 'orchard';

type TokenRow = {
  id: string;
  deploymentId: string;
  token: string | null;
  tokenHash: string;
  label: string | null;
  createdByUserId: string | null;
  originatingApiTokenId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

type Role = 'edit' | 'view';

function world(opts: { audit?: (prisma: any) => any } = {}) {
  const projects: Record<string, any> = {
    pA: { id: 'pA', organizationId: 'orgA', namespace: 'acme' },
    pB: { id: 'pB', organizationId: 'orgB', namespace: 'rival' }
  };
  const deployments: Record<string, any> = {
    depA: {
      id: 'depA',
      name: 'web',
      namespace: 'acme',
      projectId: 'pA',
      status: 'running',
      githubRepo: null,
      image: `${REGISTRY}/orchard/acme-web:v1`,
      project: projects.pA
    },
    depB: {
      id: 'depB',
      name: 'api',
      namespace: 'rival',
      projectId: 'pB',
      status: 'running',
      githubRepo: null,
      image: `${REGISTRY}/orchard/rival-api:v1`,
      project: projects.pB
    }
  };
  const tokens = new Map<string, TokenRow>();
  const apiTokens = new Map<string, any>();
  const access: Record<string, Record<string, Role>> = {
    alice: { pA: 'edit' },
    bob: { pB: 'edit' },
    vera: { pA: 'view' }
  };
  const restarts: { name: string; namespace: string }[] = [];
  const imageUpdates: { name: string; namespace: string; image: string }[] = [];
  const audits: any[] = [];
  const deleted: string[] = [];
  const findManySelects: any[] = [];
  let seq = 0;

  const prisma: any = {
    deploymentWebhookToken: {
      findUnique: async ({ where }: any) => {
        const row = [...tokens.values()].find((r) => r.tokenHash === where.tokenHash);
        return row ? { ...row, deployment: deployments[row.deploymentId] } : null;
      },
      findFirst: async ({ where }: any) =>
        [...tokens.values()].find(
          (r) => r.id === where.id && r.deploymentId === where.deploymentId
        ) ?? null,
      findMany: async ({ where, select }: any) => {
        findManySelects.push(select);
        return [...tokens.values()]
          .filter((r) => r.deploymentId === where.deploymentId)
          .map((r) =>
            Object.fromEntries(
              Object.keys(select).map((k) => [k, (r as Record<string, unknown>)[k]])
            )
          );
      },
      create: async ({ data }: any) => {
        const row: TokenRow = {
          id: `wh-${++seq}`,
          createdAt: new Date(),
          lastUsedAt: null,
          ...data
        };
        tokens.set(row.id, row);
        return row;
      },
      delete: async ({ where }: any) => {
        deleted.push(where.id);
        tokens.delete(where.id);
      },
      update: async ({ where, data }: any) => Object.assign(tokens.get(where.id) ?? {}, data)
    },
    deployment: {
      findUnique: async ({ where }: any) => deployments[where.id] ?? null,
      findFirst: async () => null,
      update: async ({ where, data }: any) => Object.assign(deployments[where.id], data)
    },
    project: { findMany: async () => [] },
    environment: { findMany: async () => [] },
    apiToken: { findUnique: async ({ where }: any) => apiTokens.get(where.id) ?? null },
    $transaction: async (fn: any) =>
      fn({
        imageHistory: {
          updateMany: async () => ({}),
          create: async () => ({}),
          findMany: async () => [],
          deleteMany: async () => ({})
        }
      })
  };

  const authz = {
    requireProjectEdit: async (projectId: string, userId: string) => {
      const role = access[userId]?.[projectId];
      if (!role) throw new NotFoundException('Project not found');
      if (role !== 'edit') throw new ForbiddenException("Your role doesn't allow you to do that");
    }
  };
  const k8s = {
    restartDeployment: async (name: string, namespace: string) => {
      restarts.push({ name, namespace });
    },
    updateDeploymentImage: async (name: string, namespace: string, image: string) => {
      imageUpdates.push({ name, namespace, image });
    }
  };
  const users = {
    findOrCreateByClerkId: async (clerkId: string) => ({ id: clerkId, email: `${clerkId}@x.test` })
  };
  const moduleRef = { get: () => ({ prepareRollout: async () => undefined }) };
  const audit = opts.audit?.(prisma) ?? { log: async (entry: any) => audits.push(entry) };

  const service = new WebhooksService(
    prisma,
    {} as any,
    k8s as any,
    users as any,
    audit,
    authz as any,
    moduleRef as any
  );

  const mint = async (deploymentId: string, user: string, apiTokenId: string | null = null) =>
    service.createWebhookToken(deploymentId, user, 'ci', apiTokenId);

  return {
    service,
    prisma,
    deployments,
    tokens,
    apiTokens,
    access,
    restarts,
    imageUpdates,
    audits,
    deleted,
    findManySelects,
    mint
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

test('a minted webhook token is stored only as its sha256 hash', async () => {
  const w = world();
  const minted = await w.mint('depA', 'alice');
  await settle();

  assert.match(minted.token, /^[0-9a-f]{64}$/);
  const row = w.tokens.get(minted.id)!;
  assert.equal(row.token, null);
  assert.equal(row.tokenHash, sha256(minted.token));
  assert.ok(!JSON.stringify(row).includes(minted.token));
  assert.equal(row.createdByUserId, 'alice');

  const second = await w.mint('depA', 'alice');
  assert.notEqual(second.token, minted.token);

  const auditText = JSON.stringify(w.audits);
  assert.ok(!auditText.includes(minted.token));
  assert.ok(!auditText.includes(row.tokenHash));
});

test('listing webhook tokens never returns the token or its hash', async () => {
  const w = world();
  const minted = await w.mint('depA', 'alice');
  const listed = await w.service.listWebhookTokens('depA', 'alice');

  const select = w.findManySelects[0];
  assert.equal(select.token, undefined);
  assert.equal(select.tokenHash, undefined);
  assert.equal(listed.length, 1);
  const text = JSON.stringify(listed);
  assert.ok(!text.includes(minted.token));
  assert.ok(!text.includes(sha256(minted.token)));
});

test('only project editors can mint, list or revoke webhook tokens', async () => {
  const w = world();
  const existing = await w.mint('depA', 'alice');

  for (const call of [
    () => w.service.createWebhookToken('depA', 'vera'),
    () => w.service.listWebhookTokens('depA', 'vera'),
    () => w.service.deleteWebhookToken('depA', existing.id, 'vera')
  ]) {
    assert.ok((await caught(call())) instanceof ForbiddenException);
  }
  for (const call of [
    () => w.service.createWebhookToken('depA', 'mallory'),
    () => w.service.listWebhookTokens('depA', 'mallory'),
    () => w.service.deleteWebhookToken('depA', existing.id, 'mallory'),
    () => w.service.createWebhookToken('depB', 'alice')
  ]) {
    assert.ok((await caught(call())) instanceof NotFoundException);
  }

  assert.equal(w.tokens.size, 1);
  assert.deepEqual(w.deleted, []);
});

test('a webhook token can only be revoked through the deployment it belongs to', async () => {
  const w = world();
  const bobs = await w.mint('depB', 'bob');

  const err = await caught(w.service.deleteWebhookToken('depA', bobs.id, 'alice'));
  assert.ok(err instanceof NotFoundException);
  assert.ok(w.tokens.has(bobs.id));

  await w.service.deleteWebhookToken('depB', bobs.id, 'bob');
  assert.ok(!w.tokens.has(bobs.id));
});

test('an unknown, malformed, revoked or rotated token gets the same not-found answer and deploys nothing', async () => {
  const w = world();

  const revoked = await w.mint('depA', 'alice');
  await w.service.deleteWebhookToken('depA', revoked.id, 'alice');

  const rotatedOld = await w.mint('depA', 'alice');
  await w.service.deleteWebhookToken('depA', rotatedOld.id, 'alice');
  const rotatedNew = await w.mint('depA', 'alice');

  const lostAccess = await w.mint('depB', 'bob');
  delete w.access.bob.pB;

  const legacyRaw = 'f'.repeat(64);
  w.tokens.set('legacy', {
    id: 'legacy',
    deploymentId: 'depA',
    token: null,
    tokenHash: sha256(legacyRaw),
    label: null,
    createdByUserId: null,
    originatingApiTokenId: null,
    createdAt: new Date(),
    lastUsedAt: null
  });

  const parentGone = await w.mint('depA', 'alice', 'gone-parent');
  w.apiTokens.set('expired-parent', {
    id: 'expired-parent',
    restrictedProjectIds: [],
    expiresAt: new Date(Date.now() - 1000)
  });
  const parentExpired = await w.mint('depA', 'alice', 'expired-parent');
  w.apiTokens.set('narrowed-parent', {
    id: 'narrowed-parent',
    restrictedProjectIds: ['pOther'],
    expiresAt: null
  });
  const parentNarrowed = await w.mint('depA', 'alice', 'narrowed-parent');

  const baseline = await caught(w.service.triggerWebhookDeploy('0'.repeat(64)));
  assert.ok(baseline instanceof NotFoundException);
  assert.equal(baseline.getStatus(), 404);
  assert.equal(baseline.message, 'Invalid webhook token');

  const attempts: Record<string, string> = {
    empty: '',
    traversal: '../../../etc/passwd',
    sqlish: "' OR 1=1 --",
    huge: 'a'.repeat(100_000),
    unicode: '\u0000😀',
    hashItself: sha256(rotatedNew.token),
    revoked: revoked.token,
    rotatedOld: rotatedOld.token,
    lostAccess: lostAccess.token,
    legacy: legacyRaw,
    parentGone: parentGone.token,
    parentExpired: parentExpired.token,
    parentNarrowed: parentNarrowed.token
  };
  for (const [name, raw] of Object.entries(attempts)) {
    const err = await caught(w.service.triggerWebhookDeploy(raw, 'nginx', 'latest'));
    assert.equal(err.constructor, NotFoundException, name);
    assert.equal(err.getStatus(), 404, name);
    assert.deepEqual(err.getResponse(), baseline.getResponse(), name);
  }

  assert.deepEqual(w.restarts, []);
  assert.deepEqual(w.imageUpdates, []);
  assert.equal(w.deployments.depA.image, `${REGISTRY}/orchard/acme-web:v1`);

  const ok = await w.service.triggerWebhookDeploy(rotatedNew.token);
  assert.equal(ok.deploymentId, 'depA');
});

test('a token that fails its re-check is purged on first use', async () => {
  const w = world();
  const lostAccess = await w.mint('depB', 'bob');
  delete w.access.bob.pB;
  w.apiTokens.set('narrowed-parent', {
    id: 'narrowed-parent',
    restrictedProjectIds: ['pOther'],
    expiresAt: null
  });
  const narrowed = await w.mint('depA', 'alice', 'narrowed-parent');

  await caught(w.service.triggerWebhookDeploy(lostAccess.token));
  await caught(w.service.triggerWebhookDeploy(narrowed.token));
  await settle();

  assert.ok(!w.tokens.has(lostAccess.id));
  assert.ok(!w.tokens.has(narrowed.id));
  const reasons = w.audits
    .filter((a) => a.action === 'deployment.webhook_triggered')
    .map((a) => a.metadata.reason);
  assert.deepEqual(reasons, ['creator_lost_access', 'originating_api_token_invalid']);
  assert.deepEqual(w.restarts, []);
});

test('a token minted by a project-scoped API token works while the API token still covers the project', async () => {
  const w = world();
  w.apiTokens.set('scoped', {
    id: 'scoped',
    restrictedProjectIds: ['pA'],
    expiresAt: new Date(Date.now() + 60_000)
  });
  const minted = await w.mint('depA', 'alice', 'scoped');
  const result = await w.service.triggerWebhookDeploy(minted.token);
  assert.deepEqual(result, { ok: true, deploymentId: 'depA', action: 'restart' });
  assert.deepEqual(w.restarts, [{ name: 'web', namespace: 'acme' }]);
});

test('token A only ever deploys the deployment it belongs to', async () => {
  const w = world();
  const a = await w.mint('depA', 'alice');
  const b = await w.mint('depB', 'bob');
  const controller = new WebhooksController(w.service);
  const hostile = {
    deploymentId: 'depB',
    projectId: 'pB',
    namespace: 'rival',
    name: 'api',
    branch: 'main',
    ref: 'refs/heads/main'
  } as any;

  const viaPath = await controller.triggerDeploy(a.token, undefined, hostile);
  const viaHeader = await controller.triggerDeployHeader(`Bearer ${a.token}`, hostile);
  const headerWins = await controller.triggerDeploy(b.token, `Bearer ${a.token}`, hostile);

  for (const result of [viaPath, viaHeader, headerWins]) {
    assert.equal(result.deploymentId, 'depA');
  }
  assert.deepEqual(w.restarts, [
    { name: 'web', namespace: 'acme' },
    { name: 'web', namespace: 'acme' },
    { name: 'web', namespace: 'acme' }
  ]);
  assert.equal(w.deployments.depB.image, `${REGISTRY}/orchard/rival-api:v1`);
});

test('a token cannot point its deployment at another project registry image', async () => {
  const w = world();
  const a = await w.mint('depA', 'alice');

  for (const image of [
    `${REGISTRY}/orchard/rival-api`,
    `${REGISTRY}/other/acme-web`,
    `${REGISTRY}/orchard/acme`,
    'localhost:5000/acme-web',
    '127.0.0.1:5000/acme-web'
  ]) {
    const err = await caught(w.service.triggerWebhookDeploy(a.token, image, 'v2'));
    assert.ok(err instanceof ForbiddenException, image);
  }
  assert.deepEqual(w.imageUpdates, []);
  assert.deepEqual(w.restarts, []);
  assert.equal(w.deployments.depA.image, `${REGISTRY}/orchard/acme-web:v1`);

  await w.service.triggerWebhookDeploy(a.token, `${REGISTRY}/orchard/acme-web`, 'v2');
  assert.deepEqual(w.imageUpdates, [
    { name: 'web', namespace: 'acme', image: `${REGISTRY}/orchard/acme-web:v2` }
  ]);
  assert.equal(w.deployments.depB.image, `${REGISTRY}/orchard/rival-api:v1`);
});

test('hostile image and tag payloads are refused before anything is deployed', async () => {
  const w = world();
  const a = await w.mint('depA', 'alice');

  const payloads: [unknown, unknown][] = [
    ['n'.repeat(1_000_000), 'v1'],
    ['nginx\nevil', 'v1'],
    ['nginx evil', 'v1'],
    ['nginx', '../../etc'],
    ['nginx', 'v1;rm -rf /'],
    ['nginx', 'v1\u0000'],
    [{ deploymentId: 'depB' }, 'v1'],
    ['nginx', ['a', 'b']],
    ['https://evil.example/x', 'v1']
  ];
  for (const [image, tag] of payloads) {
    const err = await caught(w.service.triggerWebhookDeploy(a.token, image as any, tag as any));
    assert.ok(err instanceof ForbiddenException, JSON.stringify([image, tag]).slice(0, 80));
  }
  assert.deepEqual(w.imageUpdates, []);
  assert.deepEqual(w.restarts, []);
  assert.equal(w.deployments.depA.image, `${REGISTRY}/orchard/acme-web:v1`);
});

test('an image update is refused for apps that deploy from a repository', async () => {
  const w = world();
  w.deployments.depA.githubRepo = 'acme/web';
  const a = await w.mint('depA', 'alice');

  for (const [image, tag] of [
    ['nginx', undefined],
    [undefined, 'v2']
  ] as const) {
    const err = await caught(w.service.triggerWebhookDeploy(a.token, image, tag));
    assert.ok(err instanceof BadRequestException);
  }
  assert.deepEqual(w.imageUpdates, []);
  assert.deepEqual(w.restarts, []);
});

test('each token is limited to 30 triggers a minute and other tokens keep their own budget', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const w = world();
  const a = await w.mint('depA', 'alice');
  const b = await w.mint('depB', 'bob');

  for (let i = 0; i < 30; i++) await w.service.triggerWebhookDeploy(a.token);
  const limited = await caught(w.service.triggerWebhookDeploy(a.token));
  assert.ok(limited instanceof HttpException);
  assert.equal(limited.getStatus(), 429);
  assert.equal((limited.getResponse() as any).retryAfter, 60);
  assert.equal(w.restarts.length, 30);

  await w.service.triggerWebhookDeploy(b.token);
  assert.equal(w.restarts.length, 31);
  assert.deepEqual(w.restarts.at(-1), { name: 'api', namespace: 'rival' });

  now += 30_000;
  assert.equal((await caught(w.service.triggerWebhookDeploy(a.token))).getStatus(), 429);
  assert.equal(w.restarts.length, 31);

  now += 30_001;
  await w.service.triggerWebhookDeploy(a.token);
  assert.equal(w.restarts.length, 32);
});

test('the deploy webhook is public but stays under the global throttler and a body cap', () => {
  assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, WebhooksController), true);
  const targets = [
    WebhooksController,
    WebhooksController.prototype.triggerDeploy,
    WebhooksController.prototype.triggerDeployHeader
  ];
  for (const target of targets) {
    for (const name of ['default', PRINCIPAL_THROTTLER]) {
      assert.notEqual(Reflect.getMetadata(`THROTTLER:SKIP${name}`, target), true);
    }
  }
  for (const path of ['/apiv1/webhooks/deploy', `/apiv1/webhooks/deploy/${'a'.repeat(64)}`]) {
    const tier = bodyTierFor(path);
    assert.equal(tier, 'webhook');
    assert.ok(BODY_TIER_LIMITS[tier] <= 5 * 1024 * 1024);
  }
});

test('a request without a usable token is refused before the service is called', async () => {
  const calls: unknown[] = [];
  const controller = new WebhooksController({
    triggerWebhookDeploy: async (...args: unknown[]) => calls.push(args)
  } as any);

  for (const header of [undefined, '', 'Basic abc', 'Bearer ', 'Bearer    ', 'bearer abc']) {
    const err = await caught(controller.triggerDeployHeader(header, {}));
    assert.ok(err instanceof UnauthorizedException, String(header));
  }
  assert.deepEqual(calls, []);

  await controller.triggerDeploy('path-token', 'Bearer    ', {
    image: 'nginx',
    tag: 'v1',
    deploymentId: 'depB'
  } as any);
  assert.deepEqual(calls, [['path-token', 'nginx', 'v1']]);
});

test('responses, errors and audit entries from a trigger never carry the raw token or its hash', async () => {
  const rows: any[] = [];
  const captured: any[] = [];
  const w = world({
    audit: () =>
      new AuditService(
        {
          auditLog: {
            create: async ({ data }: any) => {
              rows.push(data);
              return { id: `audit-${rows.length}`, ...data };
            }
          }
        } as any,
        { capture: (event: any) => captured.push(event) } as any
      )
  });
  const a = await w.mint('depA', 'alice');
  const hash = sha256(a.token);
  const outputs: unknown[] = [];

  outputs.push(await w.service.triggerWebhookDeploy(a.token));
  outputs.push(await w.service.triggerWebhookDeploy(a.token, `${REGISTRY}/orchard/acme-web`, 'v2'));
  outputs.push(await caught(w.service.triggerWebhookDeploy(a.token, 'x'.repeat(100_000), 'v3')));
  w.deployments.depA.status = 'building';
  outputs.push(await caught(w.service.triggerWebhookDeploy(a.token)));
  w.deployments.depA.status = 'running';
  w.deployments.depA.githubRepo = 'acme/web';
  outputs.push(await caught(w.service.triggerWebhookDeploy(a.token, 'nginx')));
  await settle();

  assert.ok(rows.length >= 5);
  const serialised = JSON.stringify({
    rows,
    captured,
    outputs: outputs.map((o) =>
      o instanceof HttpException ? { message: o.message, response: o.getResponse() } : o
    )
  });
  assert.ok(!serialised.includes(a.token));
  assert.ok(!serialised.includes(hash));
  for (const row of rows) {
    for (const value of Object.values(row.metadata ?? {})) {
      if (typeof value === 'string') assert.ok(value.length <= 257);
    }
  }
});

test.todo('webhook tokens in the deploy URL path are redacted from Datadog span URLs');

test.todo('a tag-only webhook keeps the registry host when the current image names a port');
