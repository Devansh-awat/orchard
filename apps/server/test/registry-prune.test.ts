import test from 'node:test';
import assert from 'node:assert/strict';
import { platformRegistryApi, RegistryApi, RegistryError } from '../src/docker/registry-api';
import {
  deleteTags,
  isBuildTag,
  newestBuildTags,
  platformImage,
  pruneRepository,
  type RepoKeep
} from '../src/docker/registry-prune.service';

const REPO = 'orchard/ysws-app-web';
const BASIC = `Basic ${Buffer.from('robot:secret').toString('base64')}`;

interface FakeOptions {
  auth?: 'none' | 'basic' | 'bearer';
  canDelete?: boolean;
  headDigest?: boolean;
  pageSize?: number;
  tagDelete?: boolean;
}

function fakeRegistry(tags: Record<string, string>, options: FakeOptions = {}) {
  const {
    auth = 'basic',
    canDelete = true,
    headDigest = true,
    pageSize,
    tagDelete = false
  } = options;
  const calls: string[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? '';
    calls.push(`${method} ${url.pathname}${url.search}`);

    if (url.pathname === '/service/token') {
      if (authorization !== BASIC) return new Response('', { status: 401 });
      return Response.json({ token: 'tok' });
    }
    if (auth === 'basic' && authorization !== BASIC) {
      return new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } });
    }
    if (auth === 'bearer' && authorization !== 'Bearer tok') {
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="https://registry.test/service/token",service="harbor-registry"`
        }
      });
    }

    const prefix = `/v2/${REPO}/`;
    if (!url.pathname.startsWith(prefix)) return new Response('', { status: 404 });
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));

    if (rest === 'tags/list') {
      const all = Object.keys(tags).sort();
      const last = url.searchParams.get('last');
      const from = last ? all.indexOf(last) + 1 : 0;
      const page = pageSize ? all.slice(from, from + pageSize) : all.slice(from);
      const more = pageSize && from + pageSize < all.length;
      return Response.json(
        { name: REPO, tags: page },
        more
          ? {
              headers: {
                link: `</v2/${REPO}/tags/list?n=${pageSize}&last=${page.at(-1)}>; rel="next"`
              }
            }
          : undefined
      );
    }
    const ref = rest.replace(/^manifests\//, '');
    if (method === 'HEAD' || method === 'GET') {
      const digest = tags[ref];
      if (!digest) return new Response(null, { status: 404 });
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: headDigest ? { 'docker-content-digest': digest } : {}
        });
      }
      return new Response(`manifest-${digest}`, { status: 200 });
    }
    if (method === 'DELETE') {
      if (!canDelete) return new Response('{"errors":[{"code":"DENIED"}]}', { status: 403 });
      if (!ref.startsWith('sha256:')) {
        if (!tagDelete) return new Response('{"errors":[{"code":"UNSUPPORTED"}]}', { status: 400 });
        if (!tags[ref]) return new Response(null, { status: 404 });
        delete tags[ref];
        return new Response(null, { status: 202 });
      }
      const before = Object.keys(tags).length;
      for (const [tag, digest] of Object.entries(tags)) if (digest === ref) delete tags[tag];
      return new Response(null, { status: before === Object.keys(tags).length ? 404 : 202 });
    }
    return new Response('', { status: 405 });
  }) as typeof fetch;

  const api = new RegistryApi({
    baseUrl: 'http://registry.internal',
    username: auth === 'none' ? undefined : 'robot',
    password: auth === 'none' ? undefined : 'secret',
    fetch: fetchFn
  });
  return { api, calls, tags };
}

const keepNothing = (): RepoKeep => ({ tags: new Set(), digests: new Set() });

function builds(count: number, day = '20261101'): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    out[`v${day}T${String(i).padStart(5, '0')}-${String(i).padStart(12, 'a')}`] =
      `sha256:${String(i).padStart(64, '0')}`;
  }
  return out;
}

test('recognises the tags Orchard builds and nothing else', () => {
  assert.ok(isBuildTag('v20261116T05191-f55bc104b8e0'));
  assert.ok(isBuildTag('v20261104T03493'));
  assert.ok(!isBuildTag('latest'));
  assert.ok(!isBuildTag('debug'));
  assert.ok(!isBuildTag('v20261116T05191-buildcache'));
});

test('newest build tags sort by their timestamp', () => {
  const tags = ['v20261116T05191-f55bc104b8e0', 'latest', 'v20261104T03493', 'v20261105T13373'];
  assert.deepEqual(newestBuildTags(tags, 2), ['v20261105T13373', 'v20261116T05191-f55bc104b8e0']);
});

test('prunes everything but the ten newest builds', async () => {
  const { api, tags } = fakeRegistry(builds(25));
  const result = await pruneRepository(api, REPO, keepNothing());
  assert.equal(result.deleted.length, 15);
  assert.deepEqual(Object.keys(tags).sort(), Object.keys(builds(25)).sort().slice(-10));
});

test('keeps an old build that something still references', async () => {
  const all = builds(15);
  const pinned = Object.keys(all).sort()[0];
  const { api, tags } = fakeRegistry({ ...all });
  await pruneRepository(api, REPO, { tags: new Set([pinned]), digests: new Set() });
  assert.ok(tags[pinned]);
  assert.equal(Object.keys(tags).length, 11);
});

test('keeps an old build pinned by digest', async () => {
  const all = builds(12);
  const oldest = Object.keys(all).sort()[0];
  const { api, tags } = fakeRegistry({ ...all });
  await pruneRepository(api, REPO, { tags: new Set(), digests: new Set([all[oldest]]) });
  assert.ok(tags[oldest]);
});

test('never deletes a manifest a kept tag shares', async () => {
  const all = builds(12);
  const sorted = Object.keys(all).sort();
  all[sorted[0]] = all[sorted[11]];
  const { api, tags, calls } = fakeRegistry(all);
  await pruneRepository(api, REPO, keepNothing());
  assert.ok(tags[sorted[0]]);
  assert.ok(!tags[sorted[1]]);
  assert.ok(!calls.includes(`DELETE /v2/${REPO}/manifests/${all[sorted[11]]}`));
});

test('leaves tags Orchard did not build alone', async () => {
  const all = { ...builds(11), latest: 'sha256:' + 'f'.repeat(64) };
  const { api, tags } = fakeRegistry(all);
  await pruneRepository(api, REPO, keepNothing());
  assert.ok(tags.latest);
  assert.equal(Object.keys(tags).length, 11);
});

test('a repository with nothing to prune makes no manifest requests', async () => {
  const { api, calls } = fakeRegistry(builds(10));
  await pruneRepository(api, REPO, keepNothing());
  assert.deepEqual(calls, [`GET /v2/${REPO}/tags/list?n=1000`]);
});

test('follows tag list pagination', async () => {
  const { api } = fakeRegistry(builds(7), { pageSize: 3 });
  assert.equal((await api.listTags(REPO)).length, 7);
});

test('a missing repository has no tags', async () => {
  const { api } = fakeRegistry({});
  assert.deepEqual(await api.listTags('orchard/nope'), []);
});

test('works with bearer token registries such as harbor', async () => {
  const { api, tags, calls } = fakeRegistry(builds(12), { auth: 'bearer' });
  await pruneRepository(api, REPO, keepNothing());
  assert.equal(Object.keys(tags).length, 10);
  assert.ok(calls.some((call) => call.startsWith('GET /service/token?')));
  assert.ok(
    calls
      .find((call) => call.startsWith('GET /service/token?'))!
      .includes(encodeURIComponent(`repository:${REPO}:pull,push,delete`))
  );
});

test('works with registries that need no login', async () => {
  const { api, tags } = fakeRegistry(builds(11), { auth: 'none' });
  await pruneRepository(api, REPO, keepNothing());
  assert.equal(Object.keys(tags).length, 10);
});

test('hashes the manifest when the registry omits the digest header', async () => {
  const { api } = fakeRegistry({ v20261101T00000: 'sha256:abc' }, { headDigest: false });
  const digest = await api.digestOf(REPO, 'v20261101T00000');
  assert.match(digest!, /^sha256:[0-9a-f]{64}$/);
});

test('an account without delete permission is reported as denied', async () => {
  const { api, tags } = fakeRegistry(builds(11), { canDelete: false });
  await assert.rejects(
    pruneRepository(api, REPO, keepNothing()),
    (err: unknown) => err instanceof RegistryError && err.kind === 'denied' && err.status === 403
  );
  assert.equal(Object.keys(tags).length, 11);
});

test('deleting tags keeps a manifest another tag still uses', async () => {
  const { api, tags } = fakeRegistry({
    v20261101T00001: 'sha256:same',
    v20261101T00011: 'sha256:same',
    v20261101T00002: 'sha256:old'
  });
  await deleteTags(api, REPO, ['v20261101T00001', 'v20261101T00002']);
  assert.deepEqual(tags, { v20261101T00001: 'sha256:same', v20261101T00011: 'sha256:same' });
});

test('untags a shared manifest where the registry can delete tags, as zot does', async () => {
  const { api, tags } = fakeRegistry(
    {
      v20261101T00001: 'sha256:same',
      v20261101T00011: 'sha256:same',
      v20261101T00002: 'sha256:old'
    },
    { tagDelete: true }
  );
  await deleteTags(api, REPO, ['v20261101T00001', 'v20261101T00002']);
  assert.deepEqual(tags, { v20261101T00011: 'sha256:same' });
});

test('deleting a tag that is already gone deletes nothing', async () => {
  const { api, tags, calls } = fakeRegistry({ v20261101T00011: 'sha256:new' });
  await deleteTags(api, REPO, ['v20261101T00001']);
  assert.deepEqual(tags, { v20261101T00011: 'sha256:new' });
  assert.ok(!calls.some((call) => call.startsWith('DELETE')));
});

test('talks to the push host over plain http when it is listed', () => {
  const harbor = platformRegistryApi({
    DOCKER_REGISTRY_PUSH: 'harbor-core.harbor.svc.cluster.local',
    REGISTRY_HTTP_HOSTS: 'harbor-core.harbor.svc.cluster.local,203.0.113.10'
  });
  assert.equal((harbor as any).endpoint.baseUrl, 'http://harbor-core.harbor.svc.cluster.local');
  const zot = platformRegistryApi({
    DOCKER_REGISTRY_PUSH: 'zot.orchard.svc.cluster.local:5000',
    REGISTRY_HTTP_HOSTS: 'zot.orchard.svc.cluster.local:5000'
  });
  assert.equal((zot as any).endpoint.baseUrl, 'http://zot.orchard.svc.cluster.local:5000');
  const remote = platformRegistryApi({ DOCKER_REGISTRY_PULL: 'registry.example.com' });
  assert.equal((remote as any).endpoint.baseUrl, 'https://registry.example.com');
  assert.equal(platformRegistryApi({}), null);
});

test('only images on the platform registry and project are prunable', () => {
  const env = {
    DOCKER_REGISTRY_PULL: 'registry.example.com',
    DOCKER_REGISTRY_PUSH: 'harbor-core.harbor.svc.cluster.local',
    REGISTRY_PROJECT: 'orchard'
  };
  assert.deepEqual(platformImage('registry.example.com/orchard/app-web:v20261101T00000', env), {
    repository: 'orchard/app-web',
    tag: 'v20261101T00000',
    digest: null
  });
  assert.equal(platformImage('docker.io/library/nginx:latest', env), null);
  assert.equal(platformImage('registry.example.com/other/app-web:v1', env), null);
  assert.equal(platformImage('registry.example.com/orchard/a/b:v1', env), null);
  assert.equal(platformImage(null, env), null);
});
