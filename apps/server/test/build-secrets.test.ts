import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { V1Job } from '@kubernetes/client-node';
import {
  buildSecretFlags,
  injectBuildArgsScript,
  injectableBuildArgKeys,
  localBuildArgs,
  redactBuildArgv,
  secretBuildArgNotice
} from '../src/docker/build-args';
import {
  maskSecretValues,
  registryHostsOf,
  sanitizeBuildLogMessage,
  secretValuesToMask
} from '../src/docker/build-log-redaction';
import { ImageBuilderService } from '../src/docker/image-builder.service';

const ENV = {
  API_URL: 'https://api.example.com',
  STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop',
  SHORT: 'abc'
};
const SECRET_KEYS = ['STRIPE_SECRET_KEY', 'SHORT'];

test('only non-secret keys get an auto-injected ARG', () => {
  const keys = injectableBuildArgKeys(Object.keys(ENV), SECRET_KEYS);
  assert.deepEqual(keys, ['API_URL']);
  const script = injectBuildArgsScript({ dockerfilePath: 'Dockerfile', keys });
  assert.ok(script.includes('ARG API_URL'));
  assert.ok(!script.includes('ARG STRIPE_SECRET_KEY'));
});

test('no secret keys means every key is injected', () => {
  assert.deepEqual(injectableBuildArgKeys(Object.keys(ENV), undefined), Object.keys(ENV));
});

test('secret keys become buildkit secret mounts read from the indexed env name', () => {
  const flags = buildSecretFlags(
    Object.keys(ENV),
    SECRET_KEYS,
    (_k, i) => `ORCHARD_BUILD_ARG_${i}`
  );
  assert.deepEqual(flags, [
    'id=STRIPE_SECRET_KEY,env=ORCHARD_BUILD_ARG_1',
    'id=SHORT,env=ORCHARD_BUILD_ARG_2'
  ]);
});

test('local builds keep secret values off argv and out of builder env names', () => {
  const { args, env } = localBuildArgs(ENV, SECRET_KEYS);
  assert.ok(!args.some((a) => a.includes(ENV.STRIPE_SECRET_KEY)), 'secret value reached argv');
  assert.deepEqual(args, [
    '--build-arg',
    'API_URL=https://api.example.com',
    '--secret',
    'id=STRIPE_SECRET_KEY,env=ORCHARD_BUILD_SECRET_0',
    '--build-arg',
    'STRIPE_SECRET_KEY',
    '--secret',
    'id=SHORT,env=ORCHARD_BUILD_SECRET_1',
    '--build-arg',
    'SHORT'
  ]);
  assert.deepEqual(env, {
    ORCHARD_BUILD_SECRET_0: ENV.STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY,
    ORCHARD_BUILD_SECRET_1: ENV.SHORT,
    SHORT: ENV.SHORT
  });
  assert.ok(!('API_URL' in env), 'plain values must not be exported to the builder process');
});

test('secrets named like builder settings are only handed over as secret mounts', () => {
  const { args, env } = localBuildArgs(
    { DOCKER_HOST: 'tcp://evil:2375', https_proxy: 'http://evil', DEPOT_ORG: 'x' },
    ['DOCKER_HOST', 'https_proxy', 'DEPOT_ORG']
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'ORCHARD_BUILD_SECRET_0',
    'ORCHARD_BUILD_SECRET_1',
    'ORCHARD_BUILD_SECRET_2'
  ]);
  assert.ok(!args.includes('--build-arg'));
});

test('local build args honour the skip filter', () => {
  const { args, env } = localBuildArgs({ A: '1', DOCKER_AUTH_CONFIG: '{}' }, [], (k) =>
    k.startsWith('DOCKER_')
  );
  assert.deepEqual(args, ['--build-arg', 'A=1']);
  assert.deepEqual(env, {});
});

test('build argv logging hides values', () => {
  assert.deepEqual(
    redactBuildArgv(['build', '--build-arg', 'A=1', '--build-arg', 'B', '-t', 'x']),
    ['build', '--build-arg', 'A=***', '--build-arg', 'B', '-t', 'x']
  );
});

test('only secret values of at least eight characters are masked, longest first', () => {
  const values = secretValuesToMask({ ...ENV, LONGER_SECRET: 'sk_live_abcdefghijklmnop_extra' }, [
    ...SECRET_KEYS,
    'LONGER_SECRET'
  ]);
  assert.deepEqual(values, ['sk_live_abcdefghijklmnop_extra', 'sk_live_abcdefghijklmnop']);
  assert.equal(
    maskSecretValues('key sk_live_abcdefghijklmnop_extra and sk_live_abcdefghijklmnop', values),
    'key **** and ****'
  );
});

test('masking leaves text alone when nothing is known', () => {
  assert.equal(maskSecretValues('nothing here', undefined), 'nothing here');
  assert.equal(maskSecretValues('nothing here', []), 'nothing here');
});

test('build log sanitizing hides tokens and registry hosts', () => {
  const hosts = registryHostsOf(['https://harbor.internal/orchard', null, 'harbor.internal']);
  assert.deepEqual(hosts, ['harbor.internal']);
  const out = sanitizeBuildLogMessage(
    'pushing harbor.internal/orchard/app with ghp_abcdef123 and password=hunter2',
    hosts
  );
  assert.ok(!out.includes('harbor.internal'));
  assert.ok(!out.includes('ghp_abcdef123'));
  assert.ok(!out.includes('hunter2'));
});

test('GitHub user and OAuth tokens are redacted from build logs', () => {
  for (const token of ['ghu_userToken123', 'gho_oauthToken123', 'ghr_refreshToken123']) {
    const out = sanitizeBuildLogMessage(`remote: token ${token} rejected`);
    assert.ok(!out.includes(token), out);
  }
});

async function createJob(
  t: TestContext,
  build: Partial<Parameters<ImageBuilderService['createBuildJob']>[0]>
): Promise<V1Job> {
  const env = {
    BUILDKIT_LOCAL_CACHE_ENABLED: 'false',
    BUILDKIT_S3_CACHE_ENABLED: 'false',
    BUILDER_SIDECAR_PUSH: 'false',
    DOCKER_REGISTRY_PUSH: 'registry.example.invalid',
    DOCKER_REGISTRY_PULL: 'registry.example.invalid',
    REGISTRY_PROJECT: 'orchard'
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  let job: V1Job | undefined;
  const api = {
    readNamespacedSecret: async () => {
      throw { statusCode: 404 };
    },
    createNamespacedSecret: async (_ns: string, body: unknown) => ({ body }),
    createNamespacedJob: async (_ns: string, body: V1Job) => {
      job = body;
      return { body };
    }
  };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService({} as any, {} as any, undefined as any);
  Object.assign(service, { kc: { makeApiClient: () => api }, builderInfraReady: true });
  await service.createBuildJob({
    repoUrl: 'https://github.com/example/app',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'app',
    cacheTenantKey: 'tenant',
    ...build
  });
  assert.ok(job);
  return job;
}

test('a k8s dockerfile build injects ARG only for non-secret keys and mounts secrets', async (t) => {
  const job = await createJob(t, {
    envVars: { API_URL: 'https://api.example.com', STRIPE_SECRET_KEY: 'sk_live_abcdefghijk' },
    secretEnvKeys: ['STRIPE_SECRET_KEY']
  });
  const spec = job.spec!.template.spec!;
  const inject = spec.initContainers!.find((c) => c.name === 'inject-build-args')!;
  assert.ok(inject.args![0].includes('ARG API_URL'));
  assert.ok(!inject.args![0].includes('ARG STRIPE_SECRET_KEY'));
  const buildkit = spec.containers.find((c) => c.name === 'buildkit')!;
  const script = buildkit.args![0];
  assert.ok(script.includes('build-arg:STRIPE_SECRET_KEY='), 'secret still passed as build-arg');
  assert.ok(script.includes('id=STRIPE_SECRET_KEY,env=ORCHARD_BUILD_ARG_1'));
  assert.ok(!script.includes('sk_live_abcdefghijk'), 'secret value reached the pod spec');
});

test('a k8s dockerfile build whose only var is secret skips the inject step', async (t) => {
  const job = await createJob(t, {
    envVars: { STRIPE_SECRET_KEY: 'sk_live_abcdefghijk' },
    secretEnvKeys: ['STRIPE_SECRET_KEY']
  });
  const names = job.spec!.template.spec!.initContainers!.map((c) => c.name);
  assert.ok(!names.includes('inject-build-args'));
});

test('dockerfile builds explain which secrets are no longer auto-declared', () => {
  const notice = secretBuildArgNotice(Object.keys(ENV), SECRET_KEYS);
  assert.ok(notice?.includes('STRIPE_SECRET_KEY, SHORT'));
  assert.ok(notice?.includes('ARG STRIPE_SECRET_KEY'));
  assert.ok(notice?.includes('--mount=type=secret,id=STRIPE_SECRET_KEY'));
  assert.equal(secretBuildArgNotice(Object.keys(ENV), []), null);
});
