import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EngineInformer, EngineRow, EngineStore, StoredRow, Tombstone } from '../src/engine/core';

const SHARD = 'core-test';
const KIND = 'Thing';

class MemoryStore implements EngineStore {
  rows = new Map<string, EngineRow & { tick: number }>();

  tombstones = new Map<
    string,
    { kind: string; shard: string; manifest: any; buriedAt: number; tick: number }
  >();

  now = 1_000_000;

  tick = 0;

  async listStart(): Promise<string> {
    this.tick += 1;
    return String(this.tick);
  }

  async current(entries: { uid: string; resourceVersion: string }[]): Promise<Set<string>> {
    return new Set(
      entries
        .filter((e) => this.rows.get(e.uid)?.resourceVersion === e.resourceVersion)
        .map((e) => e.uid)
    );
  }

  async load(shard: string, kind: string): Promise<StoredRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.shard === shard && r.kind === kind)
      .map((r) => ({
        uid: r.uid,
        resourceVersion: r.resourceVersion,
        derivedVersion: r.derivedVersion,
        refs: r.refs
      }));
  }

  async write(rows: EngineRow[], since?: string): Promise<void> {
    const cutoff = since === undefined ? Infinity : Number(since);
    for (const row of rows) {
      const existing = this.rows.get(row.uid);
      if (existing && existing.tick >= cutoff) continue;
      const tomb = this.tombstones.get(row.uid);
      if (tomb && tomb.tick >= cutoff) continue;
      this.tick += 1;
      this.rows.set(row.uid, { ...structuredClone(row), tick: this.tick });
      if (tomb) this.tombstones.delete(row.uid);
    }
  }

  async markDerived(
    entries: { uid: string; resourceVersion: string; derivedVersion: string }[]
  ): Promise<void> {
    for (const e of entries) {
      const row = this.rows.get(e.uid);
      if (row && row.resourceVersion === e.resourceVersion) row.derivedVersion = e.derivedVersion;
    }
  }

  async bury(
    shard: string,
    kind: string,
    obj: { uid: string; manifest: unknown },
    keepTombstone: boolean
  ): Promise<void> {
    if (this.rows.get(obj.uid)?.shard === shard) this.rows.delete(obj.uid);
    if (keepTombstone) {
      this.tick += 1;
      this.tombstones.set(obj.uid, {
        shard,
        kind,
        manifest: obj.manifest,
        buriedAt: this.now,
        tick: this.tick
      });
    }
  }

  async buryMissing(
    shard: string,
    kind: string,
    seenUids: string[],
    keepTombstones: boolean,
    retryAfterMs: number,
    since: string
  ): Promise<Tombstone[]> {
    const seen = new Set(seenUids);
    const fresh: Tombstone[] = [];
    for (const row of [...this.rows.values()]) {
      if (row.shard !== shard || row.kind !== kind || seen.has(row.uid)) continue;
      if (row.tick >= Number(since)) continue;
      this.rows.delete(row.uid);
      fresh.push({ uid: row.uid, manifest: row.manifest });
      if (keepTombstones && !this.tombstones.has(row.uid)) {
        this.tick += 1;
        this.tombstones.set(row.uid, {
          shard,
          kind,
          manifest: row.manifest,
          buriedAt: this.now,
          tick: this.tick
        });
      }
    }
    if (!keepTombstones) return fresh;
    for (const uid of seen) this.tombstones.delete(uid);
    return [...this.tombstones.entries()]
      .filter(
        ([, t]) =>
          t.shard === shard &&
          t.kind === kind &&
          (t.buriedAt === this.now || t.buriedAt < this.now - retryAfterMs)
      )
      .map(([uid, t]) => ({ uid, manifest: t.manifest }));
  }

  async forget(uid: string): Promise<void> {
    this.tombstones.delete(uid);
  }
}

interface FakeObject {
  metadata: { uid: string; name: string; namespace: string; resourceVersion: string };
}

const obj = (uid: string, name: string, rv = '1'): FakeObject => ({
  metadata: { uid, name, namespace: 'ns', resourceVersion: rv }
});

let store: MemoryStore;
let cluster: FakeObject[];
let events: string[];
let failFor: Set<string>;

function informer(withHandler = true): EngineInformer {
  const instance = new EngineInformer(
    {} as never,
    store,
    SHARD,
    {
      kind: KIND,
      apiVersion: 'v1',
      watchPath: '/things',
      list: async () => ({
        items: structuredClone(cluster),
        resourceVersion: '100',
        continueToken: null
      }),
      ...(withHandler
        ? {
            onEvent: (type: string, o: any) => {
              const name = o?.metadata?.name;
              if (failFor.has(name)) throw new Error(`handler failed for ${name}`);
              events.push(`${type}:${name}`);
            }
          }
        : {})
    },
    { onListed: () => {}, onWatchEvent: () => {}, onHealthChange: () => {} },
    { log: () => {}, warn: () => {}, error: () => {} }
  );
  (instance as unknown as { stopped: boolean }).stopped = false;
  return instance;
}

const list = (i: EngineInformer) =>
  (i as unknown as { listAndSync(count: boolean): Promise<unknown> }).listAndSync(false);

const watch = async (i: EngineInformer, phase: string, o: FakeObject) => {
  const internals = i as unknown as {
    dispatch(phase: string, o: unknown): void;
    drain(): Promise<void>;
  };
  internals.dispatch(phase, structuredClone(o));
  await internals.drain();
};

beforeEach(() => {
  store = new MemoryStore();
  cluster = [];
  events = [];
  failFor = new Set();
});

test('a delete found by the list pass reaches the handler and leaves nothing behind', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a'), obj('b', 'thing-b')];
  await list(i);
  events = [];

  cluster = [obj('a', 'thing-a')];
  await list(i);

  assert.deepEqual(events, ['delete:thing-b']);
  assert.deepEqual([...store.rows.keys()], ['a']);
  assert.equal(store.tombstones.size, 0);
});

test('a list-pass delete whose handler failed is retried once the tombstone ages', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a'), obj('b', 'thing-b')];
  await list(i);
  events = [];

  cluster = [obj('a', 'thing-a')];
  failFor.add('thing-b');
  await list(i);
  assert.deepEqual(events, []);
  assert.ok(store.tombstones.has('b'), 'the failed delete is kept');

  failFor.clear();
  store.now += 1_000;
  await list(i);
  assert.deepEqual(events, [], 'a young tombstone is left to the path that is handling it');

  store.now += 60_000;
  await list(i);
  assert.deepEqual(events, ['delete:thing-b']);
  assert.equal(store.tombstones.size, 0);
});

test('a watch delete whose handler failed is retried by a later list pass', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a')];
  await list(i);
  events = [];

  cluster = [];
  failFor.add('thing-a');
  await watch(i, 'DELETED', obj('a', 'thing-a'));
  assert.equal(store.rows.size, 0, 'readers stop seeing the object straight away');
  assert.ok(store.tombstones.has('a'));

  failFor.clear();
  store.now += 60_000;
  await list(i);
  assert.deepEqual(events, ['delete:thing-a']);
  assert.equal(store.tombstones.size, 0);
});

test('an object that comes back drops its pending delete', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a')];
  await list(i);

  failFor.add('thing-a');
  await watch(i, 'DELETED', obj('a', 'thing-a'));
  assert.ok(store.tombstones.has('a'));

  failFor.clear();
  events = [];
  cluster = [obj('a', 'thing-a', '2')];
  await watch(i, 'ADDED', obj('a', 'thing-a', '2'));
  assert.equal(store.tombstones.size, 0);

  store.now += 60_000;
  await list(i);
  assert.deepEqual(events, ['add:thing-a']);
});

test('a kind nothing derives from keeps no tombstones', async () => {
  const i = informer(false);
  cluster = [obj('a', 'thing-a')];
  await list(i);
  cluster = [];
  await list(i);
  await watch(i, 'DELETED', obj('a', 'thing-a'));
  assert.equal(store.rows.size, 0);
  assert.equal(store.tombstones.size, 0);
});

test('an object created while a list is running is never swept as gone', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a')];
  await list(i);
  events = [];

  const listed = structuredClone(cluster);
  const config = (i as any).config;
  const original = config.list;
  config.list = async () => {
    await watch(i, 'ADDED', obj('b', 'thing-b'));
    return { items: listed, resourceVersion: '200', continueToken: null };
  };
  await list(i);
  config.list = original;

  assert.ok(store.rows.has('b'), 'the watch-written row survives the sweep');
  assert.deepEqual(events, ['add:thing-b']);
});

test('a list never brings back an object the watch deleted while it ran', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a'), obj('b', 'thing-b')];
  await list(i);
  events = [];

  const listed = structuredClone(cluster);
  const config = (i as any).config;
  config.list = async () => {
    await watch(i, 'DELETED', obj('b', 'thing-b'));
    return {
      items: listed.map((o: any) => ({ ...o, metadata: { ...o.metadata, resourceVersion: '2' } })),
      resourceVersion: '200',
      continueToken: null
    };
  };
  await list(i);

  assert.equal(store.rows.has('b'), false, 'the deleted object stays deleted');
  assert.deepEqual(events, ['delete:thing-b', 'update:thing-a']);
});

test('a list snapshot older than the watch does not overwrite newer state', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a', '5')];
  await list(i);
  events = [];

  const config = (i as any).config;
  config.list = async () => {
    await watch(i, 'MODIFIED', obj('a', 'thing-a', '9'));
    return { items: [obj('a', 'thing-a', '7')], resourceVersion: '200', continueToken: null };
  };
  await list(i);

  assert.equal(store.rows.get('a')?.resourceVersion, '9');
  assert.deepEqual(events, ['update:thing-a']);
});

test('a stopped informer does not sweep or prune', async () => {
  let pruned = 0;
  const i = informer();
  (i as any).config.onListComplete = async () => {
    pruned += 1;
  };
  cluster = [obj('a', 'thing-a')];
  await list(i);
  pruned = 0;
  cluster = [];
  (i as any).config.list = async () => {
    (i as any).stopped = true;
    return { items: [], resourceVersion: '200', continueToken: null };
  };
  await list(i);
  assert.ok(store.rows.has('a'));
  assert.equal(pruned, 0);
});

test('bumping a revision re-derives every object once, then settles', async () => {
  const i = informer();
  cluster = [obj('a', 'thing-a'), obj('b', 'thing-b')];
  await list(i);
  events = [];
  await list(i);
  assert.deepEqual(events, [], 'unchanged objects are skipped');

  (i as any).config.revision = '2';
  await list(i);
  assert.deepEqual(events.sort(), ['update:thing-a', 'update:thing-b']);
  events = [];
  await list(i);
  assert.deepEqual(events, [], 'once re-derived under the new revision they are skipped again');
});
