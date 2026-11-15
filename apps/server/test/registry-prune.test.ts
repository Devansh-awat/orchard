import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ImageBuilderService } from '../src/docker/image-builder.service';

const REGISTRY = 'registry.example.invalid';
const PROJECT = 'orchard';
const REPO = 'ysws-app-web';

function fakeHarbor(t: TestContext, artifacts: Record<string, string[]>, lookupStatus = 200) {
  const calls: string[] = [];
  const base = `https://${REGISTRY}/api/v2.0/projects/${PROJECT}/repositories/${REPO}/artifacts/`;
  const digestOf = (tag: string) =>
    Object.keys(artifacts).find((digest) => artifacts[digest].includes(tag));

  t.mock.method(globalThis, 'fetch', async (input: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(input.slice(base.length)).replace(/\?.*$/, '');
    calls.push(`${method} ${path}`);
    const [ref, , tag] = path.split('/');

    if (method === 'GET') {
      if (lookupStatus !== 200) return new Response('boom', { status: lookupStatus });
      const digest = ref.startsWith('sha256:') ? ref : digestOf(ref);
      if (!digest || !artifacts[digest]) return new Response('', { status: 404 });
      return Response.json({ digest, tags: artifacts[digest].map((name) => ({ name })) });
    }
    if (tag) {
      artifacts[ref] = (artifacts[ref] ?? []).filter((name) => name !== tag);
      return new Response(null, { status: 200 });
    }
    delete artifacts[ref];
    return new Response(null, { status: 200 });
  });
  return calls;
}

function service(t: TestContext) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  process.env.HARBOR_USERNAME = 'robot';
  process.env.HARBOR_PASSWORD = 'secret';
  const svc = Object.create(ImageBuilderService.prototype) as ImageBuilderService;
  Object.assign(svc, {
    harborRegistryPush: REGISTRY,
    harborRegistryPull: REGISTRY,
    harborProject: PROJECT
  });
  return svc;
}

const image = (tag: string) => `${REGISTRY}/${PROJECT}/${REPO}:${tag}`;

test('pruning an old tag keeps a manifest a newer tag still points at', async (t) => {
  const artifacts = { 'sha256:same': ['v1', 'v11'] };
  const calls = fakeHarbor(t, artifacts);
  await service(t).deleteArtifactFromRegistry(image('v1'));
  assert.deepEqual(artifacts, { 'sha256:same': ['v11'] });
  assert.ok(!calls.includes('DELETE sha256:same'));
});

test('pruning the last tag on a manifest deletes the manifest', async (t) => {
  const artifacts: Record<string, string[]> = { 'sha256:old': ['v1'], 'sha256:new': ['v11'] };
  fakeHarbor(t, artifacts);
  await service(t).deleteArtifactFromRegistry(image('v1'));
  assert.deepEqual(artifacts, { 'sha256:new': ['v11'] });
});

test('a tag that is already gone deletes nothing', async (t) => {
  const artifacts = { 'sha256:new': ['v11'] };
  const calls = fakeHarbor(t, artifacts);
  await service(t).deleteArtifactFromRegistry(image('v1'));
  assert.deepEqual(artifacts, { 'sha256:new': ['v11'] });
  assert.deepEqual(calls, ['GET v1']);
});

test('a failed lookup deletes nothing', async (t) => {
  const artifacts = { 'sha256:same': ['v1', 'v11'] };
  const calls = fakeHarbor(t, artifacts, 500);
  await service(t).deleteArtifactFromRegistry(image('v1'));
  assert.deepEqual(artifacts, { 'sha256:same': ['v1', 'v11'] });
  assert.deepEqual(calls, ['GET v1']);
});

function fakeRegistry(t: TestContext, harbor: number | 'down', manifest: number | 'down') {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    const status = input.includes('/api/v2.0/') ? harbor : manifest;
    if (status === 'down') throw new TypeError('fetch failed');
    return new Response(null, { status });
  });
  return calls;
}

function zotService(t: TestContext) {
  const svc = service(t);
  Object.assign(svc, {
    harborRegistryPush: 'zot.orchard.svc.cluster.local:5000',
    harborRegistryPull: 'registry.orchard.local',
    plainHttpRegistries: new Set(['zot.orchard.svc.cluster.local:5000'])
  });
  return svc;
}

const zotImage = `zot.orchard.svc.cluster.local:5000/${PROJECT}/${REPO}:v1`;

test('a pushed image is found on a registry without the Harbor API', async (t) => {
  const calls = fakeRegistry(t, 'down', 200);
  assert.equal(await zotService(t).imageExistsInRegistry(zotImage), true);
  assert.ok(
    calls.includes(
      `HEAD http://zot.orchard.svc.cluster.local:5000/v2/${PROJECT}/${REPO}/manifests/v1`
    )
  );
});

test('a missing image is reported missing on a registry without the Harbor API', async (t) => {
  fakeRegistry(t, 404, 404);
  assert.equal(await zotService(t).imageExistsInRegistry(zotImage), false);
});

test('an unreachable registry answers unknown, not missing', async (t) => {
  fakeRegistry(t, 'down', 'down');
  assert.equal(await zotService(t).imageExistsInRegistry(zotImage), null);
});

test('Harbor still answers for its own images', async (t) => {
  const calls = fakeRegistry(t, 200, 401);
  assert.equal(await zotService(t).imageExistsInRegistry(zotImage), true);
  assert.equal(calls.length, 1);
});

test('a Harbor 404 stays missing when the manifest endpoint refuses basic auth', async (t) => {
  fakeRegistry(t, 404, 401);
  assert.equal(await zotService(t).imageExistsInRegistry(zotImage), false);
});
