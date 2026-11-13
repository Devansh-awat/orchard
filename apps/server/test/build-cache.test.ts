import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheEvictScript } from '../src/docker/cache-evict';
import {
  NEXT_CACHE_SUFFIX,
  applyBuildCachePatch,
  cachePruneScript,
  cacheSwapScript,
  cacheUsageScript,
  defaultBuildCacheSettings,
  parseCachePrune,
  parseCacheUsage,
  parseStoredBuildCacheSettings,
  tenantOfSubPath
} from '../src/docker/build-cache-settings';

const DAY = 86400;

function withRoot(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'build-cache-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function age(path: string, seconds: number) {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(path, when, when);
}

function seedImage(root: string, tenant: string, image: string, ageSeconds: number, kb = 4) {
  const dir = join(root, tenant, image);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'index.json'), '{}');
  writeFileSync(join(dir, 'blobs', 'layer'), Buffer.alloc(kb * 1024));
  for (const p of [join(dir, 'blobs', 'layer'), join(dir, 'blobs'), join(dir, 'index.json'), dir]) {
    age(p, ageSeconds);
  }
  age(join(root, tenant), ageSeconds);
}

function sh(script: string, root: string) {
  return execFileSync('sh', ['-c', script.replace('CACHE_ROOT="/cache"', `CACHE_ROOT="${root}"`)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

const EVICT = {
  cacheSubPath: 'mine',
  maxAgeDays: 14,
  highPct: 100,
  targetPct: 100,
  idleMinutes: 60
};

test('cache-evict drops stale image caches inside the building tenant and keeps fresh ones', () => {
  withRoot((root) => {
    seedImage(root, 'mine', 'old-app', 30 * DAY);
    seedImage(root, 'mine', 'live-app', 60);
    const out = sh(cacheEvictScript(EVICT), root);
    assert.match(out, /Evicting stale image cache: .*old-app/);
    assert.deepEqual(readdirSync(join(root, 'mine')).sort(), ['live-app']);
  });
});

test('cache-evict enforces the byte budget, oldest idle tenant first, sparing recent ones', () => {
  withRoot((root) => {
    seedImage(root, 'oldest', 'a', 5 * DAY, 400);
    seedImage(root, 'older', 'a', 3 * DAY, 400);
    seedImage(root, 'busy', 'a', 60, 400);
    let script = cacheEvictScript({ ...EVICT, maxGiB: 1 });
    script = script.replace(/^MAX_KB=.*$/m, 'MAX_KB=900');
    const out = sh(script, root);
    assert.match(out, /Over the 0GiB budget/);
    assert.ok(!existsSync(join(root, 'oldest')), out);
    assert.ok(existsSync(join(root, 'busy')), 'a tenant touched in the last hour is never evicted');
    assert.ok(existsSync(join(root, 'mine')));
  });
});

test('cache-evict leaves the budget alone when it is off', () => {
  withRoot((root) => {
    seedImage(root, 'other', 'a', 2 * DAY, 400);
    const out = sh(cacheEvictScript({ ...EVICT, maxGiB: null }), root);
    assert.doesNotMatch(out, /budget/);
    assert.ok(existsSync(join(root, 'other')));
  });
});

function swap(root: string, exitCode: number, cacheArgs = 'x') {
  const dir = join(root, 'app');
  return execFileSync(
    'sh',
    [
      '-c',
      `BUILD_EXIT_CODE=${exitCode}\nCACHE_ARGS="${cacheArgs}"\nCACHE_DIR="${dir}"\n${cacheSwapScript}`
    ],
    { encoding: 'utf8' }
  );
}

test('a successful build replaces the cache instead of piling blobs on top of it', () => {
  withRoot((root) => {
    seedImage(root, '.', 'app', 0);
    writeFileSync(join(root, 'app', 'blobs', 'orphan'), 'stale');
    seedImage(root, '.', `app${NEXT_CACHE_SUFFIX}`, 0);
    swap(root, 0);
    assert.ok(!existsSync(join(root, `app${NEXT_CACHE_SUFFIX}`)));
    assert.ok(existsSync(join(root, 'app', 'index.json')));
    assert.ok(
      !existsSync(join(root, 'app', 'blobs', 'orphan')),
      'old blobs went with the old cache'
    );
  });
});

test('a failed build or a failed export keeps the previous cache', () => {
  withRoot((root) => {
    seedImage(root, '.', 'app', 0);
    mkdirSync(join(root, `app${NEXT_CACHE_SUFFIX}`));
    swap(root, 1);
    assert.ok(existsSync(join(root, 'app', 'index.json')));
    assert.ok(!existsSync(join(root, `app${NEXT_CACHE_SUFFIX}`)));

    mkdirSync(join(root, `app${NEXT_CACHE_SUFFIX}`));
    swap(root, 0);
    assert.ok(existsSync(join(root, 'app', 'index.json')), 'no index.json means the export failed');

    seedImage(root, '.', `app${NEXT_CACHE_SUFFIX}`, 0);
    swap(root, 0, '');
    assert.ok(existsSync(join(root, 'app', 'index.json')));
    assert.ok(!existsSync(join(root, `app${NEXT_CACHE_SUFFIX}`)));
  });
});

test('usage reports every tenant with its size and last use', () => {
  withRoot((root) => {
    seedImage(root, 'big', 'a', DAY, 64);
    seedImage(root, 'small', 'a', 2 * DAY, 4);
    const usage = parseCacheUsage(sh(cacheUsageScript(), root));
    assert.deepEqual(
      usage.tenants.map((t) => t.name),
      ['big', 'small']
    );
    assert.ok(usage.tenants[0].bytes >= 64 * 1024);
    assert.ok(usage.totalBytes >= usage.tenants[0].bytes + usage.tenants[1].bytes);
    assert.ok(usage.tenants[0].lastUsedAt);
    assert.ok(usage.diskBytes && usage.diskBytes > 0);
  });
});

test('pruning idle caches skips in-use and recent tenants and reports what it freed', () => {
  withRoot((root) => {
    seedImage(root, 'stale', 'a', 2 * DAY, 64);
    seedImage(root, 'recent', 'a', 60, 64);
    seedImage(root, 'building', 'a', 2 * DAY, 64);
    const log = sh(cachePruneScript({ mode: 'idle', idleMinutes: 60, keep: ['building'] }), root);
    const result = parseCachePrune(log);
    assert.deepEqual(result.removed, ['stale']);
    assert.deepEqual(
      result.skipped.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'building', reason: 'in-use' },
        { name: 'recent', reason: 'recent' }
      ]
    );
    assert.ok(result.freedBytes >= 64 * 1024);
    assert.deepEqual(readdirSync(root).sort(), ['building', 'recent']);
  });
});

test('pruning everything still never touches a tenant with a build running', () => {
  withRoot((root) => {
    seedImage(root, 'recent', 'a', 60);
    seedImage(root, 'building', 'a', 60);
    const result = parseCachePrune(
      sh(
        cachePruneScript({ mode: 'all', idleMinutes: 60, keep: ['building', 'bad name;rm'] }),
        root
      )
    );
    assert.deepEqual(result.removed, ['recent']);
    assert.deepEqual(readdirSync(root), ['building']);
  });
});

test('settings default from env and survive bad stored values', () => {
  const defaults = defaultBuildCacheSettings({
    BUILDKIT_CACHE_MAX_GIB: '20',
    BUILDKIT_CACHE_MAX_AGE_DAYS: '7'
  });
  assert.deepEqual(defaults, { enabled: true, maxGiB: 20, maxAgeDays: 7 });
  assert.deepEqual(defaultBuildCacheSettings({}), { enabled: true, maxGiB: null, maxAgeDays: 14 });
  assert.deepEqual(parseStoredBuildCacheSettings('not json', defaults), defaults);
  assert.deepEqual(
    parseStoredBuildCacheSettings('{"enabled":false,"maxGiB":null,"maxAgeDays":-3}', defaults),
    { enabled: false, maxGiB: null, maxAgeDays: 7 }
  );
});

test('patches are validated before they are stored', () => {
  const current = { enabled: true, maxGiB: null, maxAgeDays: 14 };
  assert.deepEqual(applyBuildCachePatch(current, { enabled: false, maxGiB: 10 }), {
    enabled: false,
    maxGiB: 10,
    maxAgeDays: 14
  });
  assert.deepEqual(applyBuildCachePatch({ ...current, maxGiB: 5 }, { maxGiB: null }), current);
  assert.throws(() => applyBuildCachePatch(current, { enabled: 'yes' }), /enabled/);
  assert.throws(() => applyBuildCachePatch(current, { maxGiB: 0 }), /maxGiB/);
  assert.throws(() => applyBuildCachePatch(current, { maxGiB: 1.5 }), /maxGiB/);
  assert.throws(() => applyBuildCachePatch(current, { maxAgeDays: 400 }), /maxAgeDays/);
  assert.throws(() => applyBuildCachePatch(current, null), /settings/);
});

test('tenant keys come from the first segment of a cache subPath', () => {
  assert.equal(tenantOfSubPath('ns-abc'), 'ns-abc');
  assert.equal(tenantOfSubPath('ns-abc/state'), 'ns-abc');
  assert.equal(tenantOfSubPath(''), null);
  assert.equal(tenantOfSubPath(undefined), null);
  assert.equal(tenantOfSubPath('../x'), null);
});
