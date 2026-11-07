import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { V1Secret } from '@kubernetes/client-node';
import { ImageBuilderService } from '../src/docker/image-builder.service';

function setEnv(t: TestContext, env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function harness(t: TestContext, conflict = false) {
  setEnv(t, {
    BUILDKIT_LOCAL_CACHE_ENABLED: 'false',
    BUILDKIT_S3_CACHE_ENABLED: 'false',
    BUILDER_RUNTIME_CLASS: 'kata',
    DOCKER_REGISTRY_PUSH: 'registry.example.invalid',
    DOCKER_REGISTRY_PULL: 'registry.example.invalid',
    REGISTRY_PROJECT: 'orchard'
  });
  const created: V1Secret[] = [];
  const replaced: string[] = [];
  const api = {
    readNamespacedSecret: async () => {
      throw { statusCode: 404 };
    },
    createNamespacedSecret: async (_ns: string, body: V1Secret) => {
      if (conflict) throw { statusCode: 409 };
      created.push(body);
      return { body };
    },
    replaceNamespacedSecret: async (name: string) => {
      replaced.push(name);
      return { body: {} };
    },
    createNamespacedJob: async (_ns: string, body: unknown) => ({ body })
  };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService({} as any, {} as any, undefined as any);
  Object.assign(service, { kc: { makeApiClient: () => api }, builderInfraReady: true });
  const build = () =>
    service.createBuildJob({
      repoUrl: 'https://github.com/example/app',
      branch: 'main',
      dockerfilePath: 'Dockerfile',
      imageName: 'app',
      cacheTenantKey: 'tenant',
      envVars: { A: 'b' }
    });
  return { build, created, replaced };
}

test('build env secrets are named from 128 random bits, not the job-name suffix', async (t) => {
  const { build, created } = harness(t);
  await build();
  await build();
  const names = created.map((s) => s.metadata!.name!);
  assert.equal(names.length, 2);
  for (const name of names) assert.match(name, /^benv-[0-9a-f]{32}$/);
  assert.notEqual(names[0], names[1]);
});

test('an existing build env secret is never overwritten', async (t) => {
  const { build, replaced } = harness(t, true);
  await assert.rejects(build(), /Failed to create build job/);
  assert.deepEqual(replaced, []);
});
