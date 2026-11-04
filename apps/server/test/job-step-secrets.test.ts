import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRETS_ENCRYPTION_KEY = 'job-step-secrets-test-key';

import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { JobsService, redactStepEnv } from '../src/jobs/jobs.service';
import { JobsOrchestratorService } from '../src/jobs/jobs-orchestrator.service';

const crypto = new SecretCryptoService();

function jobs() {
  const svc = Object.create(JobsService.prototype) as JobsService;
  Object.assign(svc, {
    crypto,
    prisma: { deployment: { findMany: async () => [] } }
  });
  return (inputs: unknown[], previous: unknown[] = []) =>
    (
      svc as unknown as {
        validateSteps: (i: unknown[], p: string, prev: unknown[]) => Promise<any[]>;
      }
    ).validateSteps(inputs, 'proj', previous);
}

const scriptStep = (envVars: unknown[]) => ({
  name: 'migrate',
  type: 'script',
  script: 'echo hi',
  scriptRuntime: 'bash',
  envVars
});

test('secret step env is stored encrypted and plain env is not', async () => {
  const [step] = await jobs()([
    scriptStep([
      { key: 'API_TOKEN', value: 'tok-123' },
      { key: 'PORT', value: '80' },
      { key: 'FORCED', value: 'x', secret: true }
    ])
  ]);
  const byKey = Object.fromEntries(step.envVars.map((e: any) => [e.key, e]));
  assert.equal(byKey.API_TOKEN.secret, true);
  assert.ok(crypto.isEncrypted(byKey.API_TOKEN.value));
  assert.equal(crypto.decrypt(byKey.API_TOKEN.value), 'tok-123');
  assert.equal(byKey.PORT.secret, false);
  assert.equal(byKey.PORT.value, '80');
  assert.equal(byKey.FORCED.secret, true);
});

test('a null secret value keeps what the step already had', async () => {
  const previous = [
    {
      name: 'migrate',
      stepOrder: 1,
      envVars: [{ key: 'API_TOKEN', value: crypto.encrypt('kept'), secret: true }]
    }
  ];
  const [step] = await jobs()([scriptStep([{ key: 'API_TOKEN', value: null }])], previous);
  assert.equal(step.envVars[0].secret, true);
  assert.equal(crypto.decrypt(step.envVars[0].value), 'kept');
});

test('a sealed step var cannot be unsealed', async () => {
  const previous = [
    {
      name: 'migrate',
      stepOrder: 1,
      envVars: [{ key: 'API_TOKEN', value: crypto.encrypt('kept'), secret: true }]
    }
  ];
  await assert.rejects(
    jobs()([scriptStep([{ key: 'API_TOKEN', value: 'x', secret: false }])], previous),
    /sealed/
  );
});

test('reads never hand back a secret step value', () => {
  assert.deepEqual(
    redactStepEnv([
      { key: 'API_TOKEN', value: 'enc:v1:abc', secret: true },
      { key: 'PORT', value: '80' }
    ]),
    [
      { key: 'API_TOKEN', value: null, secret: true },
      { key: 'PORT', value: '80', secret: false }
    ]
  );
});

test('the orchestrator decrypts secret step env and keeps it routed as secret', async () => {
  const svc = Object.create(JobsOrchestratorService.prototype) as JobsOrchestratorService;
  Object.assign(svc, {
    crypto,
    logger: { warn: () => {}, log: () => {} },
    prisma: { environmentSharedVar: { findMany: async () => [] } },
    quotas: { podSizing: async () => ({ cpuMilli: 100, memoryBytes: 1 }) }
  });
  const step = await (
    svc as unknown as { resolveStep: (s: unknown, j: unknown) => Promise<any> }
  ).resolveStep(
    {
      stepOrder: 1,
      name: 'migrate',
      type: 'script',
      script: 'echo',
      scriptRuntime: 'bash',
      timeoutSeconds: 60,
      retries: 0,
      envVars: [{ key: 'API_TOKEN', value: crypto.encrypt('tok-123'), secret: true }]
    },
    { environmentId: null, project: { id: 'proj' } }
  );
  assert.deepEqual(step.envVars, [{ key: 'API_TOKEN', value: 'tok-123', secret: true }]);
});
