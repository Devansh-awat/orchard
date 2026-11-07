import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { V1Container, V1Job, V1Secret } from '@kubernetes/client-node';
import { ImageBuilderService } from '../src/docker/image-builder.service';
import {
  PROXIED_CACHE_PREFIX,
  s3CacheRoute,
  tenantCacheSegment,
  tenantWritePrefix
} from '../src/docker/build-cache-s3';

test('the proxy carries the build cache whenever it serves the cache bucket', () => {
  const proxy = {
    BACKUP_PROXY_ENABLED: 'true',
    BACKUP_PROXY_ENDPOINT: 'http://r2-proxy.orchard-r2-proxy.svc.cluster.local:9000'
  };
  assert.deepEqual(s3CacheRoute(proxy, 'orchard-backups'), {
    via: 'proxy',
    endpoint: proxy.BACKUP_PROXY_ENDPOINT,
    bucket: 'orchard-backups',
    basePrefix: PROXIED_CACHE_PREFIX
  });
  assert.equal(
    s3CacheRoute({ ...proxy, BUILDKIT_S3_BUCKET: 'orchard-backups' }, 'orchard-backups').via,
    'proxy'
  );
  assert.equal(
    s3CacheRoute({ ...proxy, BUILDKIT_S3_BUCKET: 'other' }, 'orchard-backups').via,
    'direct'
  );
  assert.equal(
    s3CacheRoute({ ...proxy, BUILDKIT_S3_BUCKET: 'other', BUILDKIT_S3_VIA_PROXY: 'true' }, null)
      .via,
    'proxy'
  );
  assert.equal(s3CacheRoute({ ...proxy, BUILDKIT_S3_VIA_PROXY: 'false' }, 'b').via, 'direct');
  assert.equal(s3CacheRoute({}, 'b').via, 'direct');
  assert.equal(s3CacheRoute(proxy, null).via, 'direct');
});

test('the proxied cache prefix cannot collide with a database backup prefix', () => {
  assert.ok(!/^[a-z0-9]/.test(PROXIED_CACHE_PREFIX));
  assert.equal(tenantWritePrefix(PROXIED_CACHE_PREFIX, 'Acme Web'), '_build-cache/acme-web/');
  assert.equal(tenantWritePrefix(PROXIED_CACHE_PREFIX, undefined), null);
  assert.ok(!tenantCacheSegment('../../x')!.includes('/'));
  assert.ok(!tenantCacheSegment('../../x')!.includes('.'));
});

const baseEnv = {
  BUILDKIT_LOCAL_CACHE_ENABLED: 'false',
  BUILDKIT_S3_CACHE_ENABLED: 'true',
  BUILDKIT_S3_ENDPOINT: 'https://account.r2.example',
  BUILDKIT_S3_BUCKET: undefined,
  BUILDKIT_S3_ACCESS_KEY_ID: 'bucketwide',
  BUILDKIT_S3_SECRET_ACCESS_KEY: 'bucketwidesecret',
  BUILDKIT_S3_VIA_PROXY: undefined,
  BUILDKIT_S3_CACHE_PREFIX: undefined,
  BACKUP_PROXY_ENABLED: 'true',
  BACKUP_PROXY_ENDPOINT: 'http://r2-proxy.orchard-r2-proxy.svc.cluster.local:9000',
  R2_ENDPOINT: 'https://account.r2.example',
  R2_ACCESS_KEY_ID: 'platform',
  R2_SECRET_ACCESS_KEY: 'platformsecret',
  R2_BACKUP_BUCKET: 'orchard-backups',
  BUILDER_RUNTIME_CLASS: 'kata',
  BUILDER_SIDECAR_PUSH: 'false',
  DOCKER_REGISTRY_PUSH: 'registry.example.invalid',
  DOCKER_REGISTRY_PULL: 'registry.example.invalid',
  REGISTRY_PROJECT: 'orchard'
};

async function createJob(
  t: TestContext,
  env: Record<string, string | undefined>,
  options: { mintFails?: boolean; jobFails?: boolean } = {}
) {
  for (const [key, value] of Object.entries({ ...baseEnv, ...env })) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const secrets = new Map<string, V1Secret>();
  const minted: any[] = [];
  const revoked: any[] = [];
  let job: V1Job | undefined;
  const api = {
    createNamespacedSecret: async (_ns: string, secret: V1Secret) => {
      secrets.set(secret.metadata!.name!, secret);
      return { body: secret };
    },
    createNamespacedJob: async (_ns: string, body: V1Job) => {
      if (options.jobFails) throw new Error('quota exceeded');
      job = body;
      return { body };
    }
  };
  const prisma = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    deployment: {
      update: async () => ({}),
      findUnique: async () => ({ projectId: 'proj-1', project: { organizationId: 'org-1' } })
    },
    storageAccessKey: {
      create: async (args: any) => {
        if (options.mintFails) throw new Error('db down');
        minted.push(args.data);
      },
      deleteMany: async (args: any) => {
        revoked.push(args.where);
      }
    }
  };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService(prisma as any, {} as any, undefined as any);
  Object.assign(service, { kc: { makeApiClient: () => api }, builderInfraReady: true });
  const run = service.createBuildJob({
    repoUrl: 'https://github.com/example/app',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'app',
    cacheTenantKey: 'acme-web',
    deploymentId: '11111111-1111-1111-1111-111111111111'
  });
  return { run, secrets, minted, revoked, job: () => job };
}

function builder(job: V1Job | undefined): V1Container {
  return job!.spec!.template.spec!.containers.find((c) => c.name === 'buildkit')!;
}

test('S3 build cache goes through the proxy with a key limited to the tenant prefix', async (t) => {
  const { run, secrets, minted, job } = await createJob(t, {});
  await run;
  assert.equal(minted.length, 1);
  assert.equal(minted[0].writePrefix, '_build-cache/acme-web/');
  assert.deepEqual(minted[0].readPrefixes, []);
  assert.equal(minted[0].organizationId, 'org-1');
  assert.equal(minted[0].purpose, 'build-cache');
  assert.ok(minted[0].expiresAt.getTime() - Date.now() <= 2 * 60 * 60 * 1000);
  assert.match(minted[0].accessKey, /^orch-[0-9a-f]{16}$/);

  const script = builder(job()).args![0];
  assert.match(
    script,
    /endpoint_url=http:\/\/r2-proxy\.orchard-r2-proxy\.svc\.cluster\.local:9000/
  );
  assert.match(script, /bucket=orchard-backups/);
  assert.match(script, /prefix=_build-cache\/acme-web\/app\//);
  assert.match(script, /touch_refresh=/);
  assert.doesNotMatch(script, /account\.r2\.example/);
  assert.doesNotMatch(script, /bucketwide/);

  const env = builder(job()).env!;
  const keyRef = env.find((e) => e.name === 'ORCHARD_S3_CACHE_KEY_ID')!.valueFrom!.secretKeyRef!;
  assert.match(keyRef.name!, /^benv-[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(env).includes('buildkit-s3-cache-creds'));
  const data = secrets.get(keyRef.name!)!.stringData!;
  assert.equal(data['orchard.s3-cache-key-id'], minted[0].accessKey);
  assert.equal(data['orchard.s3-cache-secret'], minted[0].secret);
  assert.ok(!Object.values(data).includes('bucketwidesecret'));
  assert.ok(!Object.values(data).includes('platformsecret'));
});

test('every build gets its own key, never the previous one', async (t) => {
  const first = await createJob(t, {});
  await first.run;
  const second = await createJob(t, {});
  await second.run;
  assert.notEqual(first.minted[0].accessKey, second.minted[0].accessKey);
  assert.notEqual(first.minted[0].secret, second.minted[0].secret);
});

test('without the proxy the legacy instance key stays, and says so', async (t) => {
  const { run, minted, job } = await createJob(t, { BACKUP_PROXY_ENABLED: undefined });
  await run;
  assert.equal(minted.length, 0);
  const env = builder(job()).env!;
  const ref = env.find((e) => e.name === 'ORCHARD_S3_CACHE_KEY_ID')!.valueFrom!.secretKeyRef!;
  assert.equal(ref.name, 'buildkit-s3-cache-creds');
  assert.match(builder(job()).args![0], /account\.r2\.example/);
});

test('when a scoped key cannot be minted the build runs without the S3 cache', async (t) => {
  const { run, job } = await createJob(t, {}, { mintFails: true });
  await run;
  const script = builder(job()).args![0];
  assert.doesNotMatch(script, /type=s3/);
  assert.ok(!JSON.stringify(builder(job()).env).includes('ORCHARD_S3_CACHE'));
});

test('a key minted for a job that never started is revoked', async (t) => {
  const { run, minted, revoked } = await createJob(t, {}, { jobFails: true });
  await assert.rejects(run, /Failed to create build job/);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].accessKey, minted[0].accessKey);
});
