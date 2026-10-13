import { bindTestRequestContext } from './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINEAR,
  SANDBOX_RUNNERS,
  SECTION_VALIDATORS,
  SLACK_APP,
  validateSandboxRunners,
  validateSlackApp
} from '../server/src/core/instance-config.sections';
import { CoreBindings } from '../server/src/core/core.module';
import { requestAuthStorage } from '../server/src/core/request-context';
import { InstanceConfigService } from '../server/src/core/instance-config.service';
import { InstanceSettingsService } from '../server/src/core/instance-settings.service';
import { SandboxWorkspaceService } from '../server/src/sandboxes/sandbox-workspace.service';
import { SandboxEnabledGuard } from '../server/src/sandboxes/sandbox-enabled.guard';
import { NotFoundException } from '@nestjs/common';

type Field = { key: string; type: string; env?: string; default?: unknown };
type Section = { id: string; storageKey: string; required?: string[]; fields: Field[] };

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'graft.json'), 'utf8')) as {
  settings: Section[];
  claims: { configSections: string[]; settingKeys: string[] };
};

const section = (id: string) => manifest.settings.find((s) => s.id === id)!;
const field = (id: string, key: string) => section(id).fields.find((f) => f.key === key)!;

const EMPTY_RUNNERS = {
  defaultRunner: null,
  vercelVcpus: null,
  vercelTimeoutMinutes: null,
  vercelDriveGiB: null,
  bridgeBinaryUrl: null,
  bridgeBinarySha256: null,
  previewDomain: null
};

test('the section ids the code reads are the ones graft.json declares and claims', () => {
  for (const id of [SANDBOX_RUNNERS, SLACK_APP, LINEAR]) {
    assert.ok(section(id), id);
    assert.ok(manifest.claims.configSections.includes(id), id);
    assert.ok(manifest.claims.settingKeys.includes(section(id).storageKey), id);
  }
  assert.equal(section(SANDBOX_RUNNERS).storageKey, 'sandbox_runners');
  assert.equal(section(SLACK_APP).storageKey, 'slack_app');
  assert.equal(section(LINEAR).storageKey, 'linear_integration');
});

test('the kubernetes runner ships on and vercel ships off, each pinned by its old variable', () => {
  assert.deepEqual(field(SANDBOX_RUNNERS, 'kubernetesEnabled'), {
    key: 'kubernetesEnabled',
    type: 'boolean',
    label: 'Kubernetes runner',
    env: 'SANDBOX_RUNNER_KUBERNETES_ENABLED',
    default: true
  });
  assert.equal(field(SANDBOX_RUNNERS, 'vercelEnabled').default, false);
  assert.equal(field(SANDBOX_RUNNERS, 'vercelEnabled').env, 'SANDBOX_RUNNER_VERCEL_ENABLED');
});

test('tokens and signing secrets are secret fields', () => {
  assert.equal(field(SANDBOX_RUNNERS, 'vercelToken').type, 'secret');
  assert.deepEqual(
    section(SLACK_APP)
      .fields.filter((f) => f.type === 'secret')
      .map((f) => f.key),
    ['signingSecret', 'botToken']
  );
  assert.deepEqual(
    section(LINEAR).fields.map((f) => [f.key, f.type === 'secret']),
    [['webhookSecret', true]]
  );
  assert.deepEqual(section(SLACK_APP).required, ['signingSecret', 'botToken']);
  assert.deepEqual(section(LINEAR).required, ['webhookSecret']);
});

test('sandbox runner settings refuse values the runners could not use', () => {
  const check = (patch: Record<string, string>) =>
    validateSandboxRunners({ ...EMPTY_RUNNERS, ...patch });
  assert.throws(() => check({ defaultRunner: 'docker' }), /defaultRunner/);
  assert.throws(() => check({ vercelVcpus: '0' }), /vercelVcpus/);
  assert.throws(() => check({ vercelVcpus: '9' }), /vercelVcpus/);
  assert.throws(() => check({ vercelTimeoutMinutes: 'soon' }), /vercelTimeoutMinutes/);
  assert.throws(() => check({ vercelDriveGiB: '20000' }), /vercelDriveGiB/);
  assert.throws(() => check({ vercelDriveGiB: '1.5' }), /vercelDriveGiB/);
  assert.throws(
    () => check({ bridgeBinaryUrl: 'http://insecure.example.com/b' }),
    /bridgeBinaryUrl/
  );
  assert.throws(() => check({ previewDomain: 'https://preview.example.com' }), /previewDomain/);
  assert.throws(() => check({ bridgeBinarySha256: 'abc123' }), /bridgeBinarySha256/);
  assert.doesNotThrow(() =>
    check({
      defaultRunner: 'vercel',
      vercelVcpus: '4',
      vercelTimeoutMinutes: '45',
      vercelDriveGiB: '100',
      bridgeBinaryUrl: 'https://assets.example.com/bridge',
      bridgeBinarySha256: 'ab'.repeat(32),
      previewDomain: 'preview.example.com'
    })
  );
  assert.doesNotThrow(() => check({}));
});

test('a preview domain on the same site as Orchard is refused by the runner settings', () => {
  const prev = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://app.orchard.test';
  try {
    assert.throws(() =>
      validateSandboxRunners({ ...EMPTY_RUNNERS, previewDomain: 'orchard.test' })
    );
  } finally {
    if (prev === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = prev;
  }
});

test('the slack app wants a bot token and a real app id', () => {
  assert.throws(
    () => validateSlackApp({ botToken: 'xoxp-user', appId: null, signingSecret: 'x' }),
    /xoxb/
  );
  assert.throws(
    () => validateSlackApp({ botToken: 'xoxb-1', appId: 'nope', signingSecret: 'x' }),
    /appId/
  );
  assert.doesNotThrow(() =>
    validateSlackApp({ botToken: 'xoxb-1', appId: 'A0123456', signingSecret: 'x' })
  );
});

test('the validators are attached to their sections through the settings door at boot', () => {
  const attached = new Map<string, unknown>();
  const auth = { requestContext: () => ({ sessionOrgId: 'org' }), runWithContext: () => null };
  new CoreBindings(
    auth as any,
    {
      validate: (id: string, check: unknown) => attached.set(id, check)
    } as any
  );
  assert.equal(attached.get(SANDBOX_RUNNERS), validateSandboxRunners);
  assert.equal(attached.get(SLACK_APP), validateSlackApp);
  assert.equal(attached.has(LINEAR), false);
  assert.equal(SECTION_VALIDATORS.length, 2);
  assert.deepEqual(requestAuthStorage.getStore(), { sessionOrgId: 'org' });
  bindTestRequestContext();
  assert.equal(requestAuthStorage.getStore(), undefined);
});

test('config reads go through the settings door by section id', () => {
  const reads: string[] = [];
  const config = new InstanceConfigService({
    generation: 7,
    value: (id: string, key: string) => {
      reads.push(`${id}.${key}`);
      return 'v';
    },
    flag: (id: string, key: string) => {
      reads.push(`flag:${id}.${key}`);
      return true;
    }
  } as any);
  assert.equal(config.generation, 7);
  assert.equal(config.value(SANDBOX_RUNNERS, 'previewDomain'), 'v');
  assert.equal(config.flag(SANDBOX_RUNNERS, 'vercelEnabled'), true);
  assert.deepEqual(reads, ['sandbox-runners.previewDomain', 'flag:sandbox-runners.vercelEnabled']);
});

test('installing Greenhouse turns it on; stored instance keys go through the settings door', async () => {
  const stored = new Map<string, string>();
  const settings = new InstanceSettingsService({
    stored: async (key: string) => stored.get(key) ?? null,
    storeIfAbsent: async (key: string, value: string) => {
      if (stored.has(key)) return false;
      stored.set(key, value);
      return true;
    }
  } as any);
  assert.equal(await settings.isSandboxesEnabled(), true);
  assert.equal(await settings.createIfAbsent('sandbox_instance_id', 'a'), true);
  assert.equal(await settings.createIfAbsent('sandbox_instance_id', 'b'), false);
  assert.equal(await settings.get('sandbox_instance_id'), 'a');
  assert.ok(manifest.claims.settingKeys.includes('sandbox_instance_id'));
});

test('a repo or file name arriving as an array is rejected, not coerced', () => {
  const svc = new SandboxWorkspaceService(null as never, null as never, null as never);
  assert.throws(
    () => svc.resolveWorkdir({ repoUrl: null }, ['a/../../etc'] as never),
    /Invalid repo name/
  );
  assert.equal(svc.resolveWorkdir({ repoUrl: null }, 'myrepo'), '/persist/home/myrepo');
});

test('the Greenhouse routes answer only to people the PostHog flag lets in', async () => {
  const flagged = new Set(['in']);
  const asked: string[] = [];
  const analytics = {
    configured: true,
    isFeatureEnabled: async (key: string, id: string) => {
      asked.push(`${key}:${id}`);
      return flagged.has(id);
    }
  };
  const context = (userId?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ auth: userId ? { userId } : undefined }) })
    }) as any;
  const guard = new SandboxEnabledGuard(analytics);
  assert.equal(await guard.canActivate(context('in')), true);
  await assert.rejects(guard.canActivate(context('out')), NotFoundException);
  await assert.rejects(guard.canActivate(context()), NotFoundException);
  assert.deepEqual(asked, ['greenhouse:in', 'greenhouse:out']);
  const unflagged = new SandboxEnabledGuard({
    configured: false,
    isFeatureEnabled: async () => false
  });
  assert.equal(await unflagged.canActivate(context()), true);
});
