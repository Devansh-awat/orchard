import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bucketFromDestination,
  buildContextStorage,
  buildsCanReach,
  currentProxyTarget,
  externalUploadStorage,
  hasBackupRoute,
  objectStorage,
  platformBackupTarget,
  setObjectStorageOverride,
  storageFeatures,
  tenantBackupTarget,
  uploadStorage
} from '../src/instance-config/object-storage';
import { probeStorage, storageProbeTarget } from '../src/instance-config/storage-probe';
import {
  mergeProxyTargets,
  proxyUpstreamDocument
} from '../src/kubernetes/backup-upstream-sync.service';
import { isServableUploadPath } from '../src/organizations/uploads.controller';
import { STORAGE } from '../src/instance-config/instance-config.sections';

const NAMES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_PUBLIC_URL',
  'R2_BUILD_CONTEXT_BUCKET',
  'R2_BACKUP_BUCKET',
  'R2_REGION',
  'R2_PATH_STYLE',
  'LOCAL_STORE_ENDPOINT',
  'LOCAL_STORE_BACKUP_BUCKET',
  'LOCAL_STORE_UPLOADS_BUCKET',
  'LOCAL_STORE_ACCESS_KEY_ID',
  'LOCAL_STORE_SECRET_ACCESS_KEY',
  'LOCAL_STORE_REGION',
  'LOCAL_DEPLOYS_ENABLED',
  'BACKUP_PROXY_ENABLED',
  'BACKUP_PROXY_CHART_UPSTREAM'
];

async function withStorage(
  env: Record<string, string>,
  stored: Record<string, string>,
  fn: () => Promise<void> | void
) {
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, env);
  setObjectStorageOverride(stored);
  try {
    await fn();
  } finally {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    setObjectStorageOverride({});
  }
}

const PRODUCTION_ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'prod-key',
  R2_SECRET_ACCESS_KEY: 'prod-secret',
  R2_BUCKET_NAME: 'prod-assets',
  R2_PUBLIC_URL: 'https://assets.example.com',
  R2_BACKUP_BUCKET: 'prod-backups',
  BACKUP_PROXY_ENABLED: 'true',
  BACKUP_PROXY_CHART_UPSTREAM: 'true'
};

const LOCAL_ENV = {
  LOCAL_STORE_ENDPOINT: 'http://object-storage.orchard-object-storage.svc.cluster.local:9000',
  LOCAL_STORE_BACKUP_BUCKET: 'orchard-backups',
  LOCAL_STORE_UPLOADS_BUCKET: 'orchard-uploads',
  LOCAL_STORE_ACCESS_KEY_ID: 'local-key',
  LOCAL_STORE_SECRET_ACCESS_KEY: 'local-secret',
  LOCAL_STORE_REGION: 'auto',
  BACKUP_PROXY_ENABLED: 'true'
};

const STORED_S3 = {
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  pathStyle: 'false',
  accessKeyId: 'stored-key',
  secretAccessKey: 'stored-secret',
  bucketName: 'my-bucket',
  backupBucket: 'my-bucket'
};

test('production env keeps every R2 path, region and URL it had', () =>
  withStorage(PRODUCTION_ENV, {}, () => {
    const s = objectStorage();
    assert.equal(s.endpoint, 'https://acct.r2.cloudflarestorage.com');
    assert.equal(s.region, 'auto');
    assert.equal(s.pathStyle, null);
    const target = platformBackupTarget()!;
    assert.equal(target.bucket, 'prod-backups');
    assert.equal(target.local, false);
    assert.equal(target.pathStyle, true);
    const uploads = uploadStorage()!;
    assert.equal(uploads.bucket, 'prod-assets');
    assert.equal(uploads.publicUrl, 'https://assets.example.com');
    assert.equal(uploads.keyPrefix, '');
    assert.equal(uploads.pathStyle, false);
    assert.equal(currentProxyTarget(), null);
    assert.equal(buildContextStorage(), null);
    assert.equal(storageFeatures().localDeploys, false);
  }));

test('production keeps local deploys only through the explicit flag', () =>
  withStorage(
    { ...PRODUCTION_ENV, LOCAL_DEPLOYS_ENABLED: 'true', R2_BUILD_CONTEXT_BUCKET: 'ctx' },
    {},
    () => {
      assert.equal(buildContextStorage()?.bucket, 'ctx');
    }
  ));

test('an installer box backs up to the local store, unlocked, without touching R2 fields', () =>
  withStorage(LOCAL_ENV, {}, () => {
    const target = platformBackupTarget()!;
    assert.equal(target.local, true);
    assert.equal(target.bucket, 'orchard-backups');
    assert.equal(objectStorage().endpoint, null);
    assert.deepEqual(storageFeatures(), {
      s3: false,
      backups: 'local',
      uploads: true,
      localDeploys: false
    });
    assert.equal(hasBackupRoute(null), true);
    assert.equal(currentProxyTarget(), null);
    assert.equal(externalUploadStorage(), null);
    const uploads = uploadStorage()!;
    assert.equal(uploads.bucket, 'orchard-uploads');
    assert.equal(uploads.publicUrl, '/apiv1/uploads');
    assert.equal(uploads.keyPrefix, 'uploads/');
    assert.equal(uploads.pathStyle, true);
  }));

test('saved storage replaces the local target and turns local deploys on', () =>
  withStorage(LOCAL_ENV, STORED_S3, () => {
    const target = platformBackupTarget()!;
    assert.equal(target.local, false);
    assert.equal(target.bucket, 'my-bucket');
    assert.equal(target.region, 'eu-west-1');
    assert.equal(target.pathStyle, false);
    assert.equal(currentProxyTarget()?.bucket, 'my-bucket');
    const uploads = uploadStorage()!;
    assert.equal(uploads.bucket, 'my-bucket');
    assert.equal(uploads.publicUrl, '/apiv1/uploads');
    assert.equal(uploads.keyPrefix, 'uploads/');
    assert.equal(uploads.pathStyle, false);
    assert.equal(buildContextStorage()?.bucket, 'my-bucket');
    assert.equal(buildContextStorage()?.pathStyle, false);
    assert.equal(storageFeatures().backups, 'external');
  }));

test('nothing configured is a clean off state', () =>
  withStorage({}, {}, () => {
    assert.equal(platformBackupTarget(), null);
    assert.equal(uploadStorage(), null);
    assert.equal(buildContextStorage(), null);
    assert.deepEqual(storageFeatures(), {
      s3: false,
      backups: 'none',
      uploads: false,
      localDeploys: false
    });
  }));

test('the explicit override turns local deploys off', () =>
  withStorage({ ...LOCAL_ENV, LOCAL_DEPLOYS_ENABLED: 'false' }, STORED_S3, () => {
    assert.equal(buildContextStorage(), null);
  }));

test('builds cannot reach an in-cluster or private endpoint, so local deploys stay off', () => {
  assert.equal(buildsCanReach('https://s3.eu-west-1.amazonaws.com'), true);
  assert.equal(buildsCanReach('https://acct.r2.cloudflarestorage.com'), true);
  assert.equal(buildsCanReach('http://s3.example.com'), true);
  assert.equal(buildsCanReach('https://s3.example.com:9000'), false);
  assert.equal(buildsCanReach('http://minio.storage.svc.cluster.local'), false);
  assert.equal(buildsCanReach('http://minio.storage.svc'), false);
  assert.equal(buildsCanReach('http://minio'), false);
  assert.equal(buildsCanReach('http://192.168.1.5'), false);
  assert.equal(buildsCanReach('http://10.0.0.1'), false);
  assert.equal(buildsCanReach('http://100.70.1.1'), false);
  return withStorage(
    LOCAL_ENV,
    { ...STORED_S3, endpoint: 'http://minio.storage.svc.cluster.local:9000' },
    () => {
      assert.equal(buildContextStorage(), null);
    }
  );
});

test('stored storage never reaches tenants without the proxy; explicit R2 env still can', async () => {
  await withStorage({}, STORED_S3, () => {
    assert.equal(platformBackupTarget()?.bucket, 'my-bucket');
    assert.equal(tenantBackupTarget(), null);
    assert.equal(hasBackupRoute(null), false);
  });
  const { BACKUP_PROXY_ENABLED: _proxy, ...env } = PRODUCTION_ENV;
  await withStorage(env, {}, () => {
    assert.equal(tenantBackupTarget()?.bucket, 'prod-backups');
  });
});

test('R2 env wins over stored values and locks them', () =>
  withStorage({ R2_BACKUP_BUCKET: 'pinned', R2_REGION: 'wnam' }, STORED_S3, () => {
    assert.equal(objectStorage().backupBucket, 'pinned');
    assert.equal(objectStorage().region, 'wnam');
  }));

test('a stray stored region or addressing style cannot change an env-managed instance', () =>
  withStorage(PRODUCTION_ENV, { region: 'eu', pathStyle: 'true' }, () => {
    assert.equal(objectStorage().region, 'auto');
    assert.equal(objectStorage().pathStyle, null);
    assert.equal(uploadStorage()!.pathStyle, false);
  }));

test('a public URL with a shared bucket is refused, and so is the local store name', () =>
  withStorage(LOCAL_ENV, {}, () => {
    assert.throws(
      () => STORAGE.validate!({ ...STORED_S3, publicUrl: 'https://cdn.example.com' }),
      /separate bucket/
    );
    assert.doesNotThrow(() =>
      STORAGE.validate!({
        ...STORED_S3,
        bucketName: 'public-assets',
        publicUrl: 'https://cdn.example.com'
      })
    );
    assert.throws(() => STORAGE.validate!({ backupBucket: 'orchard-backups' }), /different bucket/);
    assert.throws(() => STORAGE.validate!({ endpoint: 'not a url' }), /plain address/);
  }));

test('the proxy keeps every bucket a database may still be archiving to', () => {
  const old = {
    bucket: 'first',
    endpoint: 'https://a',
    region: 'auto',
    accessKey: 'a',
    secretKey: 'a',
    pathStyle: true
  };
  const current = {
    bucket: 'second',
    endpoint: 'https://b',
    region: 'us-east-1',
    accessKey: 'b',
    secretKey: 'b',
    pathStyle: false,
    local: false
  };
  const merged = mergeProxyTargets([old], current);
  assert.deepEqual(
    merged.map((t) => t.bucket),
    ['first', 'second']
  );
  const rotated = mergeProxyTargets(merged, { ...current, accessKey: 'rotated' });
  assert.equal(rotated.length, 2);
  assert.equal(rotated[1].accessKey, 'rotated');
  assert.deepEqual(JSON.parse(proxyUpstreamDocument(merged, current)!).defaultBucket, 'second');
  assert.deepEqual(JSON.parse(proxyUpstreamDocument(merged, null)!).defaultBucket, '');
  assert.equal(proxyUpstreamDocument([], null), null);
});

test('only plain upload paths are served', () => {
  assert.equal(isServableUploadPath('organizations/ab-12.png'), true);
  assert.equal(isServableUploadPath('favicons/example.com.png'), true);
  assert.equal(isServableUploadPath('../secrets'), false);
  assert.equal(isServableUploadPath('a/../b'), false);
  assert.equal(isServableUploadPath('rootfile'), false);
  assert.equal(isServableUploadPath('a//b'), false);
});

test('the archive bucket is read from the destination path', () => {
  assert.equal(bucketFromDestination('s3://orchard-backups/ns/pg'), 'orchard-backups');
  assert.equal(bucketFromDestination(null), null);
  assert.equal(bucketFromDestination('https://x'), null);
});

test('the probe target keeps a stored secret when the field is blank', () => {
  const target = storageProbeTarget(
    { endpoint: 'https://s3.example.com', backupBucket: 'b', secretAccessKey: '' },
    { accessKeyId: 'stored', secretAccessKey: 'stored-secret', region: 'eu' }
  );
  assert.ok(typeof target !== 'string');
  assert.equal(target.secretAccessKey, 'stored-secret');
  assert.equal(target.region, 'eu');
  assert.equal(target.pathStyle, true);
  assert.deepEqual(target.buckets, ['b']);
  assert.equal(storageProbeTarget({}, {}), 'Enter an endpoint.');
  assert.equal(storageProbeTarget({ endpoint: 'https://x.io' }, {}), 'Enter a bucket.');
});

async function fakeS3(handler: (method: string, host: string, path: string) => number) {
  const seen: { method: string; host: string; path: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    const host = req.headers.host ?? '';
    const path = (req.url ?? '').split('?')[0];
    seen.push({ method: req.method!, host, path, authorization: req.headers.authorization ?? '' });
    req.resume();
    req.on('end', () => {
      const status = handler(req.method!, host, path);
      if (status === 200 && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(
          '<?xml version="1.0"?><ListBucketResult><Name>b</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'
        );
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/xml' });
      const code = status === 404 ? 'NoSuchBucket' : status === 403 ? 'AccessDenied' : '';
      res.end(code ? `<Error><Code>${code}</Code><Message>${code}</Message></Error>` : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('the probe lists, writes and deletes, path style, signing with the region', async () => {
  const s3 = await fakeS3(() => 200);
  try {
    const result = await probeStorage({
      endpoint: `http://127.0.0.1:${s3.port}`,
      buckets: ['my-bucket'],
      region: 'eu-central-003',
      pathStyle: true,
      accessKeyId: 'AK',
      secretAccessKey: 'SK'
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(
      s3.seen.map((r) => r.method),
      ['GET', 'PUT', 'DELETE']
    );
    assert.equal(s3.seen[1].path, '/my-bucket/.orchard-connection-test');
    assert.match(s3.seen[0].authorization, /\/eu-central-003\/s3\/aws4_request/);
  } finally {
    await s3.close();
  }
});

test('probe failures say what to fix and never carry the secret', async () => {
  const missing = await fakeS3(() => 404);
  const denied = await fakeS3((method) => (method === 'PUT' ? 403 : 200));
  try {
    const base = {
      buckets: ['my-bucket'],
      region: 'auto',
      pathStyle: true,
      accessKeyId: 'AK',
      secretAccessKey: 'very-secret-value'
    };
    const noBucket = await probeStorage({ ...base, endpoint: `http://127.0.0.1:${missing.port}` });
    assert.equal(noBucket.ok, false);
    assert.match((noBucket as any).message, /does not exist/);
    const readOnly = await probeStorage({ ...base, endpoint: `http://127.0.0.1:${denied.port}` });
    assert.equal(readOnly.ok, false);
    assert.match((readOnly as any).message, /list, read, write and delete/);
    assert.doesNotMatch(JSON.stringify([noBucket, readOnly]), /very-secret-value/);
  } finally {
    await missing.close();
    await denied.close();
  }
});
