import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterSettled,
  FALLBACK_POSTGRES_IMAGES,
  hourInWindow,
  imageRepository,
  isOutdated,
  parseHourWindow,
  parsePostgresImageCatalog,
  pickImageRolloutBatch,
  resolvePostgresImage,
  validPostgresImages,
  type ImageRolloutCandidate
} from '../src/kubernetes/postgres-images';
import {
  PG_COLLATION_ANNOTATION,
  POSTGRES_IMAGE_ROLLOUT_HALT_KEY,
  PostgresImageService
} from '../src/kubernetes/postgres-image.service';

const D = (c: string) => c.repeat(64);
const img = (tag: string, digest = 'a') =>
  `ghcr.io/cloudnative-pg/postgresql:${tag}@sha256:${D(digest)}`;

const CATALOG = `apiVersion: postgresql.cnpg.io/v1
kind: ClusterImageCatalog
metadata:
  name: postgresql-system-trixie
  labels:
    images.cnpg.io/date: '20261019'
spec:
  images:
  - major: 17
    image: ${img('17.11-202610190957-system-trixie')}
  - major: 18
    image: ${img('18.6-202610190957-system-trixie', 'b')}
`;

test('a CNPG catalog parses into one image per major with its date', () => {
  const parsed = parsePostgresImageCatalog(CATALOG);
  assert.equal(parsed.catalogDate, '20261019');
  assert.deepEqual(Object.keys(parsed.images), ['17', '18']);
  assert.throws(() => parsePostgresImageCatalog('kind: Deployment'));
});

test('only digest-pinned images whose tag matches their major and repository survive', () => {
  const kept = validPostgresImages(
    {
      17: img('17.11-system-trixie'),
      16: 'ghcr.io/cloudnative-pg/postgresql:16.15-system-trixie',
      15: img('16.15-system-trixie'),
      14: `docker.io/evil/postgresql:14.1@sha256:${D('c')}`
    },
    { repository: 'ghcr.io/cloudnative-pg/postgresql' }
  );
  assert.deepEqual(Object.keys(kept), ['17']);
});

test('the compiled-in fallback is itself valid for every major orchard offers', () => {
  const kept = validPostgresImages({ ...FALLBACK_POSTGRES_IMAGES });
  for (const major of [13, 14, 15, 16, 17, 18]) assert.ok(kept[major], `missing ${major}`);
});

test('an env pin beats the channel, which beats the fallback, which beats the bare tag', () => {
  const channel = { images: { 17: img('17.12-x') }, source: 's', catalogDate: null, fetchedAt: '' };
  assert.equal(
    resolvePostgresImage(17, channel, { POSTGRES_IMAGE_17: 'mirror/pg:17' }),
    'mirror/pg:17'
  );
  assert.equal(resolvePostgresImage(17, channel, {}), img('17.12-x'));
  assert.equal(resolvePostgresImage(16, channel, {}), FALLBACK_POSTGRES_IMAGES[16]);
  assert.equal(resolvePostgresImage(99, null, {}), 'ghcr.io/cloudnative-pg/postgresql:99');
});

test('image repository strips tag and digest but keeps registry ports', () => {
  assert.equal(imageRepository(img('17.1')), 'ghcr.io/cloudnative-pg/postgresql');
  assert.equal(imageRepository('reg.local:5000/pg/postgresql:17'), 'reg.local:5000/pg/postgresql');
});

test('rollout windows can wrap midnight', () => {
  assert.deepEqual(parseHourWindow('22-2', [8, 11]), [22, 2]);
  assert.deepEqual(parseHourWindow('junk', [8, 11]), [8, 11]);
  assert.ok(hourInWindow(23, [22, 2]));
  assert.ok(hourInWindow(1, [22, 2]));
  assert.ok(!hourInWindow(12, [22, 2]));
  assert.ok(hourInWindow(9, [8, 11]));
});

test('only same-major images from our repositories count as outdated', () => {
  const target = img('17.11-system-trixie');
  assert.ok(isOutdated({ current: 'ghcr.io/cloudnative-pg/postgresql:17', target }));
  assert.ok(!isOutdated({ current: target, target }));
  assert.ok(!isOutdated({ current: 'ghcr.io/cloudnative-pg/postgresql:16', target }));
  assert.ok(!isOutdated({ current: 'postgis/postgis:17-3.5', target }));
  assert.ok(!isOutdated({ current: null, target }));
});

const cand = (name: string, extra: Partial<ImageRolloutCandidate> = {}): ImageRolloutCandidate => ({
  namespace: 'ns',
  clusterName: name,
  current: 'ghcr.io/cloudnative-pg/postgresql:17',
  target: img('17.11-system-trixie'),
  healthy: true,
  hibernated: false,
  backupRunning: false,
  collation: null,
  ...extra
});

test('the batch skips unhealthy, hibernated, backing-up and non-C clusters and is capped', () => {
  const batch = pickImageRolloutBatch(
    [
      cand('d'),
      cand('a', { healthy: false }),
      cand('b', { hibernated: true }),
      cand('c', { backupRunning: true }),
      cand('e', { collation: 'other' }),
      cand('f'),
      cand('g')
    ],
    2
  );
  assert.deepEqual(
    batch.map((c) => c.clusterName),
    ['d', 'f']
  );
});

test('a cluster has settled once healthy with every instance ready on the target image', () => {
  const target = img('17.11-system-trixie');
  const c = (status: any, instances = 1) => ({ spec: { instances }, status });
  assert.ok(
    clusterSettled(
      c({ phase: 'Cluster in healthy state', readyInstances: 1, image: target }),
      target
    )
  );
  assert.ok(
    !clusterSettled(c({ phase: 'Upgrading cluster', readyInstances: 1, image: target }), target)
  );
  assert.ok(
    !clusterSettled(c({ phase: 'Cluster in healthy state', readyInstances: 1 }, 2), target)
  );
  assert.ok(
    !clusterSettled(
      c({ phase: 'Cluster in healthy state', readyInstances: 1, image: 'old' }),
      target
    )
  );
});

function liveCluster(
  name: string,
  opts: { image?: string; phase?: string; annotations?: any } = {}
) {
  const image = opts.image ?? 'ghcr.io/cloudnative-pg/postgresql:17';
  return {
    metadata: { namespace: 'ns', name, annotations: opts.annotations ?? {} },
    spec: { instances: 1, imageName: image },
    status: {
      phase: opts.phase ?? 'Cluster in healthy state',
      readyInstances: 1,
      image,
      currentPrimary: `${name}-1`
    }
  };
}

function rolloutHarness(
  clusters: any[],
  opts: { collation?: 'c' | 'other' | null; enabled?: boolean } = {}
) {
  const settings = new Map<string, string>();
  const patched: string[] = [];
  const s = Object.create(PostgresImageService.prototype) as any;
  Object.assign(s, {
    refresh: async () => null,
    logger: { warn() {}, log() {}, error() {} },
    channel: null,
    lastBatch: [],
    timers: [],
    rolling: false,
    prisma: {
      database: {
        findMany: async () =>
          clusters.map((c) => ({ namespace: 'ns', clusterName: c.metadata.name, pgMajor: 17 }))
      }
    },
    settings: {
      isPostgresAutoUpdateEnabled: async () => opts.enabled ?? true,
      get: async (k: string) => settings.get(k) ?? null,
      set: async (k: string, v: string) => {
        settings.set(k, v);
      }
    },
    k8sCnpg: {
      canRunClusterWide: () => true,
      listAllCnpgClusters: async () => clusters,
      listAllCnpgBackups: async () => [],
      probeClusterCollation: async () => (opts.collation === undefined ? 'c' : opts.collation),
      annotateCnpgCluster: async () => {},
      patchClusterImage: async (_ns: string, name: string, image: string) => {
        patched.push(name);
        const c = clusters.find((x) => x.metadata.name === name);
        c.spec.imageName = image;
        c.status.phase = 'Upgrading cluster';
      }
    }
  });
  return { s, settings, patched };
}

const inWindow = new Date('2026-10-24T09:00:00Z');

test('the rollout patches at most one batch inside the window and nothing outside it', async () => {
  const clusters = ['a', 'b', 'c', 'd', 'e'].map((n) => liveCluster(n));
  const { s, patched } = rolloutHarness(clusters);
  const outside = await s.rolloutTick(new Date('2026-10-24T15:00:00Z'));
  assert.equal(outside.outdated, 5);
  assert.deepEqual(patched, []);
  const inside = await s.rolloutTick(inWindow);
  assert.deepEqual(inside.patched, ['ns/a', 'ns/b', 'ns/c']);
});

test('the next batch waits for the last one, and an unhealthy cluster halts the rollout', async () => {
  const clusters = ['a', 'b', 'c', 'd'].map((n) => liveCluster(n));
  const { s, settings, patched } = rolloutHarness(clusters);
  await s.rolloutTick(inWindow);
  assert.equal(patched.length, 3);
  const waiting = await s.rolloutTick(new Date(inWindow.getTime() + 5 * 60_000));
  assert.deepEqual(waiting.patched, []);
  const halted = await s.rolloutTick(new Date(inWindow.getTime() + 11 * 60_000));
  assert.match(halted.halted, /ns\/a was not healthy/);
  assert.ok(settings.get(POSTGRES_IMAGE_ROLLOUT_HALT_KEY));
  const after = await s.rolloutTick(new Date(inWindow.getTime() + 12 * 60_000));
  assert.deepEqual(after.patched, []);
  assert.equal(patched.length, 3);
});

test('a batch that comes back healthy lets the next one go', async () => {
  const clusters = ['a', 'b', 'c', 'd'].map((n) => liveCluster(n));
  const { s, patched } = rolloutHarness(clusters);
  await s.rolloutTick(inWindow);
  for (const c of clusters.slice(0, 3)) {
    c.status.phase = 'Cluster in healthy state';
    c.status.image = c.spec.imageName;
  }
  const next = await s.rolloutTick(new Date(inWindow.getTime() + 10 * 60_000));
  assert.deepEqual(next.patched, ['ns/d']);
  assert.equal(patched.length, 4);
});

test('a database on a non-C collation is held instead of moved to a new OS image', async () => {
  const { s, patched } = rolloutHarness([liveCluster('a')], { collation: 'other' });
  const r = await s.rolloutTick(inWindow);
  assert.deepEqual(r.held, ['ns/a']);
  assert.deepEqual(patched, []);
  const { s: s2, patched: p2 } = rolloutHarness([
    liveCluster('b', { annotations: { [PG_COLLATION_ANNOTATION]: 'other' } })
  ]);
  await s2.rolloutTick(inWindow);
  assert.deepEqual(p2, []);
});

test('turning auto-update off stops the rollout entirely', async () => {
  const { s, patched } = rolloutHarness([liveCluster('a')], { enabled: false });
  assert.equal(await s.rolloutTick(inWindow), null);
  assert.deepEqual(patched, []);
});
