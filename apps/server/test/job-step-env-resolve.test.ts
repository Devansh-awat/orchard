import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRETS_ENCRYPTION_KEY = 'job-step-env-test-key';

import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { JobsOrchestratorService } from '../src/jobs/jobs-orchestrator.service';

const crypto = new SecretCryptoService();
const ENV_ID = 'env-1';

function orchestrator(opts: {
  shared?: { key: string; value: string; secret: boolean }[];
  deployment?: {
    id: string;
    image: string;
    envVars: { key: string; value: string; secret: boolean }[];
  };
  bound?: Record<string, { fields: Record<string, string>; secretFields?: string[] }>;
}) {
  const sharedRows = (opts.shared ?? []).map((v) => ({
    ...v,
    value: crypto.encryptIfSecret(v.value, v.secret)
  }));
  const warnings: string[] = [];
  const svc = Object.create(JobsOrchestratorService.prototype) as JobsOrchestratorService;
  Object.assign(svc, {
    crypto,
    logger: { warn: (m: string) => warnings.push(m), log: () => {} },
    prisma: {
      environmentSharedVar: {
        findMany: async ({ where }: { where: { environmentId: string } }) =>
          where.environmentId === ENV_ID ? sharedRows : []
      },
      deployment: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          opts.deployment && opts.deployment.id === where.id
            ? {
                ...opts.deployment,
                envVars: opts.deployment.envVars.map((v) => ({
                  ...v,
                  value: crypto.encryptIfSecret(v.value, v.secret)
                }))
              }
            : null
      }
    },
    quotas: {
      podSizing: async () => ({ cpuMilli: 500, memoryBytes: 256 * 1024 * 1024 })
    },
    resourceBindings: { valuesFor: async () => opts.bound ?? {} }
  });
  const resolve = (step: Record<string, unknown>, environmentId: string | null = ENV_ID) =>
    (svc as unknown as { resolveStep: (s: unknown, j: unknown) => Promise<any> }).resolveStep(
      { timeoutSeconds: 600, retries: 0, ...step },
      { environmentId, project: { id: 'proj' } }
    );
  return { resolve, warnings };
}

test('a script step expands ${{shared.KEY}} from the job environment', async () => {
  const { resolve } = orchestrator({
    shared: [
      { key: 'SIMPLEFIN_ACCESS_URL', value: 'https://bridge.simplefin.org/x', secret: false }
    ]
  });
  const step = await resolve({
    stepOrder: 1,
    name: 'sync',
    type: 'script',
    scriptRuntime: 'node',
    script: 'console.log(1)',
    envVars: [{ key: 'SIMPLEFIN_ACCESS_URL', value: '${{shared.SIMPLEFIN_ACCESS_URL}}' }]
  });
  assert.deepEqual(step.envVars, [
    { key: 'SIMPLEFIN_ACCESS_URL', value: 'https://bridge.simplefin.org/x', secret: false }
  ]);
});

test('a secret shared var makes the referencing step var secret', async () => {
  const { resolve } = orchestrator({
    shared: [{ key: 'TOKEN', value: 'tok-123', secret: true }]
  });
  const step = await resolve({
    stepOrder: 1,
    name: 'notify',
    type: 'image',
    image: 'curlimages/curl',
    command: { shell: 'curl -H "Authorization: $AUTH"' },
    envVars: [{ key: 'AUTH', value: 'Bearer ${{shared.TOKEN}}' }]
  });
  assert.deepEqual(step.envVars, [{ key: 'AUTH', value: 'Bearer tok-123', secret: true }]);
});

test('an app step resolves the inherited deployment env, step overrides and resource refs', async () => {
  const { resolve } = orchestrator({
    shared: [{ key: 'REGION', value: 'eu', secret: false }],
    deployment: {
      id: 'dep-1',
      image: 'ghcr.io/acme/app:sha',
      envVars: [
        { key: 'DATABASE_URL', value: '${{resource.db.connection_string}}', secret: false },
        { key: 'REGION', value: '${{shared.REGION}}', secret: false },
        { key: 'MODE', value: 'serve', secret: false }
      ]
    },
    bound: {
      db: {
        fields: { connection_string: 'postgres://app:pw@db-rw:5432/app' },
        secretFields: ['connection_string']
      }
    }
  });
  const step = await resolve({
    stepOrder: 2,
    name: 'migrate',
    type: 'app',
    deploymentId: 'dep-1',
    command: { shell: 'pnpm migrate' },
    envVars: [{ key: 'MODE', value: 'migrate-${{shared.REGION}}' }]
  });
  assert.equal(step.image, 'ghcr.io/acme/app:sha');
  assert.deepEqual(Object.fromEntries(step.envVars.map((e: any) => [e.key, e])), {
    DATABASE_URL: {
      key: 'DATABASE_URL',
      value: 'postgres://app:pw@db-rw:5432/app',
      secret: true
    },
    REGION: { key: 'REGION', value: 'eu', secret: false },
    MODE: { key: 'MODE', value: 'migrate-eu', secret: false }
  });
});

test('a missing shared key resolves to empty and is logged, never shipped literally', async () => {
  const { resolve, warnings } = orchestrator({ shared: [] });
  const step = await resolve({
    stepOrder: 1,
    name: 'sync',
    type: 'script',
    scriptRuntime: 'bash',
    script: 'echo',
    envVars: [{ key: 'URL', value: '${{shared.NOPE}}' }]
  });
  assert.deepEqual(step.envVars, [{ key: 'URL', value: '', secret: false }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /URL references shared\.NOPE/);
});

test('a job outside any environment resolves against an empty shared set', async () => {
  const { resolve } = orchestrator({ shared: [{ key: 'A', value: '1', secret: false }] });
  const step = await resolve(
    {
      stepOrder: 1,
      name: 'sync',
      type: 'script',
      scriptRuntime: 'bash',
      script: 'echo',
      envVars: [{ key: 'A', value: '${{shared.A}}' }]
    },
    null
  );
  assert.deepEqual(step.envVars, [{ key: 'A', value: '', secret: false }]);
});
