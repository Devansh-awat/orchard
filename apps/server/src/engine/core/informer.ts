import * as k8s from '@kubernetes/client-node';
import { consoleLogger, EngineLogger } from './logger';
import { EngineRefs, EngineRow, EngineStore, sameRefs, StoredRow } from './store';

export type { EngineRefs } from './store';

export type EngineEventType = 'add' | 'update' | 'delete';

export interface EngineListOptions {
  limit: number;
  continueToken?: string;
}

export interface EngineListPage {
  items: any[];
  resourceVersion: string;
  continueToken?: string | null;
}

export interface EngineObjectKey {
  namespace: string;
  name: string;
  // What this pass resolved the object's owners to, or null when resolution
  // failed. A pruner that sees a null knows its picture of the cluster is
  // incomplete and must not delete anything on the strength of it.
  refs: EngineRefs | null;
}

export interface EngineResource {
  kind: string;
  apiVersion: string;
  watchPath: string;
  labelSelector?: string;
  fieldSelector?: string;
  list(kc: k8s.KubeConfig, opts: EngineListOptions): Promise<EngineListPage>;
  // Resolve the Orchard rows an object belongs to. Returning `{}` means "it
  // belongs to nothing", which is a real answer and gets stored. Throwing means
  // "could not tell", which is not: the informer then leaves the row alone and
  // retries, rather than recording a mapping it does not actually have.
  mapRefs?(obj: any): Promise<EngineRefs>;
  // Apply the object to whatever Orchard state derives from it. Must throw on
  // failure. A handler that swallows its own errors tells the informer the
  // version was applied when it was not, and nothing will ever come back for it.
  onEvent?(type: EngineEventType, obj: any): void | Promise<void>;
  onListComplete?(seen: EngineObjectKey[]): Promise<void>;
  sanitize?(obj: any): any;
}

export interface EngineShard {
  name: string;
  lease: string;
  resources: EngineResource[];
}

export interface EngineInformerHooks {
  onListed(resourceVersion: string): void;
  onWatchEvent(): void;
  onHealthChange(healthy: boolean, error: string | null): void;
}

// Objects pulled per LIST page. Bounds peak memory on the initial sync: without
// it a cluster with tens of thousands of objects arrives as one response and one
// array of full manifests.
const LIST_PAGE_SIZE = 500;

const WRITE_CHUNK = 100;

// How many watch events may be in flight at once. Events for the same object
// are always serialized (see `enqueue`); this only bounds cross-object fan-out
// so a mass rollout can't open hundreds of concurrent transactions.
const EVENT_CONCURRENCY = 12;

// How long after a deferred write or a failed handler to run a repair list.
// Short enough that a blip is invisible to anyone watching the UI, spaced out
// enough that a database having a bad minute is not answered with a full list
// every thirty seconds.
const REPAIR_DELAY_MS = 30_000;
const REPAIR_MIN_SPACING_MS = 60_000;
const WATCH_DELETE_MEMORY_MS = 15 * 60_000;

// An object on its way into the mirror, carrying the refs already resolved for
// it so nothing has to resolve them twice.
interface PendingWrite {
  obj: any;
  refs: EngineRefs;
}

class Semaphore {
  private active = 0;

  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

// A 410 means the resourceVersion we asked to resume from has aged out of the
// apiserver's watch cache, which is the only case that genuinely requires a
// fresh LIST. Everything else reconnects from where it left off.
function isExpiredError(err: unknown): boolean {
  const any = err as any;
  const code = any?.statusCode ?? any?.response?.statusCode ?? any?.code ?? any?.body?.code;
  if (code === 410) return true;
  const message = String(any?.body?.message ?? any?.message ?? '');
  return /too old resource version|resource version.*too old|expired/i.test(message);
}

function errorText(err: unknown): string {
  const message = (err as any)?.body?.message ?? (err as Error)?.message ?? String(err);
  return String(message).slice(0, 300);
}

export class EngineInformer {
  private readonly logger: EngineLogger;

  private req?: { abort(): void };

  private backoffMs = 1000;

  private stopped = true;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private repairTimer?: ReturnType<typeof setTimeout>;

  private lastRepairAt = 0;

  // Serializes list passes. The resync timer, a watch reconnect and a repair
  // can all ask for one at the same time, and two of them interleaving would
  // let one pass's stale sweep race the other's writes.
  private syncChain: Promise<unknown> = Promise.resolve();

  // One promise chain per object natural key. Events for the same object stay
  // strictly ordered (a DELETE must not overtake the ADD of a same-named
  // replacement), events for different objects run concurrently.
  private readonly chains = new Map<string, Promise<void>>();

  private readonly sem = new Semaphore(EVENT_CONCURRENCY);

  private connectedAt = 0;

  private readonly watchDeletes = new Map<string, number>();

  private resourceVersion = '';

  private needsRelist = true;

  private watchOk = true;

  private writeOk = true;

  private healthy = true;

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly store: EngineStore,
    private readonly shard: string,
    private readonly config: EngineResource,
    private readonly hooks: EngineInformerHooks,
    logger?: EngineLogger
  ) {
    this.logger = logger ?? consoleLogger(`Engine:${shard}/${config.kind}`);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.listThenWatch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
    try {
      this.req?.abort();
    } catch {}
    this.req = undefined;
    await this.drain();
    await this.syncChain.catch(() => {});
  }

  async resync(): Promise<number> {
    if (this.stopped) return 0;
    try {
      const { repairs } = await this.listAndSync(true);
      return repairs;
    } catch (err) {
      this.logger.warn(`resync failed: ${errorText(err)}`);
      return 0;
    }
  }

  private async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]).catch(() => {});
    }
  }

  // A shard is only healthy when both halves of the pipeline work: a live watch
  // and writes that land. Tracking them separately keeps a persistent write
  // failure from being papered over by the next successful watch reconnect.
  private setWatchHealth(ok: boolean, error: string | null): void {
    this.watchOk = ok;
    this.publishHealth(error);
  }

  private setWriteHealth(ok: boolean, error: string | null): void {
    this.writeOk = ok;
    this.publishHealth(error);
  }

  private publishHealth(error: string | null): void {
    const healthy = this.watchOk && this.writeOk;
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    this.hooks.onHealthChange(healthy, healthy ? null : error);
  }

  private async listThenWatch(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.needsRelist || !this.resourceVersion) {
        const { resourceVersion } = await this.listAndSync(false);
        this.resourceVersion = resourceVersion;
        this.needsRelist = false;
        this.hooks.onListed(resourceVersion);
      }
      await this.startWatch(this.resourceVersion);
      this.connectedAt = Date.now();
      this.setWatchHealth(true, null);
    } catch (err) {
      if (isExpiredError(err)) this.needsRelist = true;
      const text = errorText(err);
      this.logger.warn(`list+watch failed: ${text}`);
      this.setWatchHealth(false, text);
      this.scheduleRestart();
    }
  }

  private listAndSync(
    countRepairs: boolean
  ): Promise<{ resourceVersion: string; repairs: number }> {
    return this.serialize(() => this.runListAndSync(countRepairs));
  }

  private async runListAndSync(
    countRepairs: boolean
  ): Promise<{ resourceVersion: string; repairs: number }> {
    if (this.stopped) return { resourceVersion: this.resourceVersion, repairs: 0 };

    const startedAt = Date.now();
    for (const [uid, at] of this.watchDeletes) {
      if (startedAt - at > WATCH_DELETE_MEMORY_MS) this.watchDeletes.delete(uid);
    }
    const since = await this.store.listStart();
    const existingRows = await this.store.load(this.shard, this.config.kind);
    const existing = new Map(existingRows.map((r) => [r.uid, r]));

    const seenUids: string[] = [];
    const seenKeys: EngineObjectKey[] = [];
    let repairs = 0;
    let deferred = 0;
    let resourceVersion = '';
    let continueToken: string | undefined;
    let pending: PendingWrite[] = [];
    let underived: PendingWrite[] = [];

    do {
      const page = await this.config.list(this.kc, {
        limit: LIST_PAGE_SIZE,
        continueToken
      });
      // Paginated LIST is a consistent read: every page reports the snapshot's
      // resourceVersion, so the first one is the version to resume watching at.
      if (!resourceVersion && page.resourceVersion) resourceVersion = page.resourceVersion;
      continueToken = page.continueToken || undefined;

      for (const raw of page.items) {
        const obj = this.normalize(raw);
        const uid = obj.metadata?.uid;
        if (!uid) continue;
        if ((this.watchDeletes.get(uid) ?? 0) >= startedAt) continue;
        seenUids.push(uid);

        // Refs are re-derived every pass, not only when the manifest moved. A
        // pod whose deployment row landed a moment after the pod did would
        // otherwise keep the empty mapping it was born with for as long as it
        // stays untouched, and a pod that goes ready and then sits there stays
        // untouched for good.
        const resolved = await this.resolveRefs(obj);
        seenKeys.push({
          namespace: obj.metadata.namespace ?? '',
          name: obj.metadata.name,
          refs: resolved.ok ? resolved.refs : null
        });
        if (!resolved.ok) {
          // Leave the row untouched. Its stored resourceVersion stays behind
          // the cluster's, which is exactly what gets it retried below.
          deferred += 1;
          continue;
        }

        const state = this.classify(existing.get(uid), obj, resolved.refs);
        if (state === 'current') continue;

        if (countRepairs) repairs += 1;
        if (state === 'underived') {
          // The manifest we hold is already the right one, so there is nothing
          // to rewrite — only the state derived from it is missing.
          underived.push({ obj, refs: resolved.refs });
          if (underived.length >= WRITE_CHUNK) {
            await this.deriveCurrent(underived);
            underived = [];
          }
          continue;
        }
        pending.push({ obj, refs: resolved.refs });
        if (pending.length >= WRITE_CHUNK) {
          await this.flush(pending, since);
          pending = [];
        }
      }
      if (this.stopped) return { resourceVersion: this.resourceVersion, repairs: 0 };
    } while (continueToken);

    if (pending.length > 0) await this.flush(pending, since);
    if (underived.length > 0) await this.deriveCurrent(underived);

    if (this.stopped) return { resourceVersion: this.resourceVersion, repairs: 0 };
    repairs += await this.sweepStale(seenUids, countRepairs, since);

    if (this.stopped) return { resourceVersion: this.resourceVersion, repairs: 0 };
    if (this.config.onListComplete) {
      await this.config.onListComplete(seenKeys).catch((err) => {
        this.logger.warn(`onListComplete failed: ${errorText(err)}`);
      });
    }

    if (deferred > 0) {
      this.logger.warn(`${deferred} object(s) deferred with unresolved refs`);
      this.scheduleRepair();
    }

    return { resourceVersion, repairs };
  }

  /**
   * What a listed object needs from this pass.
   *
   *   current    the manifest matches, its refs still resolve to what is
   *              stored, and the consumer has applied that exact version
   *   underived  we hold the right manifest but nothing derived from it, so
   *              the consumer runs again and no manifest is rewritten
   *   stale      the manifest or the mapping moved and the row is rewritten
   *
   * `current` is deliberately the strictest of the three. Skipping on the
   * resourceVersion alone means a single failed write becomes permanent — the
   * object is passed over from then on precisely because it never changes
   * again, which is how a running pod ends up reading "pending" for six days.
   */
  private classify(
    prior: StoredRow | undefined,
    obj: any,
    refs: EngineRefs
  ): 'current' | 'underived' | 'stale' {
    if (!prior) return 'stale';
    const rv = String(obj.metadata.resourceVersion ?? '');
    if (prior.resourceVersion !== rv) return 'stale';
    if (!sameRefs(prior.refs, refs)) return 'stale';
    return prior.derivedVersion === rv ? 'current' : 'underived';
  }

  private async resolveRefs(obj: any): Promise<{ ok: boolean; refs: EngineRefs }> {
    if (!this.config.mapRefs) return { ok: true, refs: {} };
    try {
      return { ok: true, refs: await this.config.mapRefs(obj) };
    } catch (err) {
      this.logger.warn(`mapRefs failed for ${obj?.metadata?.name}: ${errorText(err)}`);
      return { ok: false, refs: {} };
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.syncChain.then(fn, fn);
    this.syncChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Queue a repair list after something failed to land. The periodic resync
   * would get there eventually; this shortens "eventually" from ten minutes to
   * thirty seconds without letting a persistently sick dependency turn into a
   * list every thirty seconds forever.
   */
  private scheduleRepair(): void {
    if (this.stopped || this.repairTimer) return;
    const delay = Math.max(REPAIR_DELAY_MS, this.lastRepairAt + REPAIR_MIN_SPACING_MS - Date.now());
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      this.lastRepairAt = Date.now();
      void this.resync().then((repaired) => {
        if (repaired > 0) this.logger.log(`repair pass rewrote ${repaired} object(s)`);
      });
    }, delay);
    this.repairTimer.unref?.();
  }

  private async sweepStale(
    seenUids: string[],
    countRepairs: boolean,
    since: string
  ): Promise<number> {
    const handler = this.config.onEvent;
    const buried = await this.store.buryMissing(
      this.shard,
      this.config.kind,
      seenUids,
      Boolean(handler),
      REPAIR_DELAY_MS,
      since
    );
    if (!handler) return countRepairs ? buried.length : 0;
    for (const row of buried) {
      try {
        await handler('delete', row.manifest);
        await this.store.forget(row.uid);
      } catch (err) {
        this.logger.warn(`delete handler failed for ${row.uid}: ${errorText(err)}`);
        this.scheduleRepair();
      }
    }
    return countRepairs ? buried.length : 0;
  }

  private async flush(entries: PendingWrite[], since: string): Promise<void> {
    try {
      await this.writeRows(
        entries.map((e) => this.toRow(e.obj, e.refs)),
        since
      );
    } catch (err) {
      // A failed chunk leaves those rows behind rather than aborting the whole
      // list — the seen set is still complete, so the stale sweep downstream
      // stays correct, and the rows keep their old resourceVersion so the next
      // pass comes back for them.
      this.logger.warn(`batch write of ${entries.length} objects failed: ${errorText(err)}`);
      this.scheduleRepair();
      return;
    }
    await this.deriveCurrent(entries);
  }

  private async deriveCurrent(entries: PendingWrite[]): Promise<void> {
    if (entries.length === 0 || this.stopped) return;
    let fresh: Set<string>;
    try {
      fresh = await this.store.current(
        entries.map((e) => ({
          uid: String(e.obj.metadata.uid),
          resourceVersion: String(e.obj.metadata.resourceVersion ?? '')
        }))
      );
    } catch (err) {
      this.logger.warn(
        `could not check ${entries.length} object(s) before deriving: ${errorText(err)}`
      );
      this.scheduleRepair();
      return;
    }
    await this.derive(
      'update',
      entries.filter((e) => fresh.has(String(e.obj.metadata.uid)))
    );
  }

  /**
   * Hand the objects to the consumer, then record the version it applied.
   *
   * The mark is the whole point. `resource_version` alone says "we hold this
   * manifest"; `derived_version` says "everything Orchard derives from this
   * manifest has been written". Only a row where both match the cluster may be
   * skipped, so a handler that throws — or a process that dies between the
   * write and the handler — is retried on the next pass instead of hiding
   * behind a resourceVersion that already looks up to date.
   *
   * `bounded` is the semaphore invariant: a permit is held for exactly one
   * level of the call stack. The list path arrives here holding none and fans a
   * whole chunk out under the limit; the watch path already took a permit for
   * the entire event in `enqueue` and must not ask for a second one. It used
   * to, and a node going down was enough to wedge the shard for good: once
   * EVENT_CONCURRENCY pods changed at the same time, every permit was held by
   * an event waiting on a permit only one of the others could release. Nothing
   * else moved after that — no updates, no deletes, and the resync that was
   * supposed to repair it blocked in here too, so the mirror served a snapshot
   * of the cluster as it was the moment the node died until the process
   * restarted.
   */
  private async derive(
    type: EngineEventType,
    entries: PendingWrite[],
    bounded = true
  ): Promise<void> {
    if (!this.config.onEvent || entries.length === 0) return;
    const applied = await Promise.all(
      entries.map((entry) =>
        bounded ? this.sem.run(() => this.apply(type, entry)) : this.apply(type, entry)
      )
    );
    const ok = applied.filter((entry): entry is PendingWrite => entry !== null);
    if (ok.length < entries.length) this.scheduleRepair();
    await this.markDerived(ok);
  }

  private async apply(type: EngineEventType, entry: PendingWrite): Promise<PendingWrite | null> {
    try {
      await this.config.onEvent!(type, entry.obj);
      return entry;
    } catch (err) {
      this.logger.warn(`event handler failed for ${entry.obj?.metadata?.name}: ${errorText(err)}`);
      return null;
    }
  }

  private async markDerived(entries: PendingWrite[]): Promise<void> {
    if (entries.length === 0) return;
    const uids = entries.map((e) => String(e.obj.metadata.uid));
    const versions = entries.map((e) => String(e.obj.metadata.resourceVersion ?? ''));
    try {
      await this.store.markDerived(uids.map((uid, i) => ({ uid, resourceVersion: versions[i] })));
    } catch (err) {
      this.logger.warn(`marking ${entries.length} object(s) derived failed: ${errorText(err)}`);
      this.scheduleRepair();
    }
  }

  private async startWatch(resourceVersion: string): Promise<void> {
    if (this.stopped) return;
    const watch = new k8s.Watch(this.kc);
    const queryParams: Record<string, unknown> = {
      allowWatchBookmarks: true,
      resourceVersion
    };
    if (this.config.labelSelector) queryParams.labelSelector = this.config.labelSelector;
    if (this.config.fieldSelector) queryParams.fieldSelector = this.config.fieldSelector;

    this.req = await watch.watch(
      this.config.watchPath,
      queryParams,
      (phase, obj) => this.dispatch(phase, obj),
      (err) => this.onDone(err)
    );
  }

  private dispatch(phase: string, raw: any): void {
    if (this.stopped) return;

    // Track progress on every message, bookmarks included — that is the whole
    // point of asking for them. Without this a reconnect has nothing newer than
    // the last full LIST to resume from and has to re-pull the world.
    const rv = raw?.metadata?.resourceVersion;
    if (rv) this.resourceVersion = String(rv);

    if (phase === 'BOOKMARK') return;
    if (phase === 'ERROR') {
      if (isExpiredError(raw)) this.needsRelist = true;
      const text = errorText(raw);
      this.logger.warn(`watch error event: ${text}`);
      this.setWatchHealth(false, text);
      // The apiserver normally closes the stream after an ERROR frame, but do
      // not depend on it — aborting drives the done callback and the reconnect.
      try {
        this.req?.abort();
      } catch {}
      return;
    }

    const obj = this.normalize(raw);
    if (!obj.metadata?.uid || !obj.metadata?.name) return;
    this.hooks.onWatchEvent();

    const key = `${obj.metadata.namespace ?? ''}/${obj.metadata.name}`;
    this.enqueue(key, () => this.handle(phase, obj));
  }

  private enqueue(key: string, fn: () => Promise<void>): void {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.sem.run(fn))
      .catch((err) => {
        // The watch has already moved past this event, so nothing else will
        // bring it back — a repair list is the only thing that will.
        this.logger.warn(`event handling failed for ${key}: ${errorText(err)}`);
        this.scheduleRepair();
      })
      .then(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async handle(phase: string, obj: any): Promise<void> {
    if (this.stopped) return;

    if (phase === 'DELETED') {
      this.watchDeletes.set(String(obj.metadata.uid), Date.now());
      const handler = this.config.onEvent;
      try {
        await this.store.bury(
          this.shard,
          this.config.kind,
          { uid: obj.metadata.uid, manifest: obj },
          Boolean(handler)
        );
      } catch (err) {
        this.logger.warn(
          `delete of ${obj.metadata.namespace}/${obj.metadata.name} failed: ${errorText(err)}`
        );
        this.scheduleRepair();
        return;
      }
      if (!handler) return;
      await handler('delete', obj);
      await this.store.forget(obj.metadata.uid);
      return;
    }

    this.watchDeletes.delete(String(obj.metadata.uid));
    const resolved = await this.resolveRefs(obj);
    if (!resolved.ok) {
      // Writing a row whose refs we could not resolve is worse than writing
      // nothing: it would either erase a mapping that was correct or advance
      // the resourceVersion that is the retry's only handle on the object.
      this.scheduleRepair();
      return;
    }

    // Write first, derive second: consumers emit the SSE that sends clients
    // straight back to read the mirror, so the row has to be there before they
    // are told to look.
    await this.writeRows([this.toRow(obj, resolved.refs)]);
    await this.derive(phase === 'ADDED' ? 'add' : 'update', [{ obj, refs: resolved.refs }], false);
  }

  private onDone(err: unknown): void {
    if (this.stopped) return;
    this.req = undefined;
    if (Date.now() - this.connectedAt > 60_000) this.backoffMs = 1000;
    if (err) {
      if (isExpiredError(err)) this.needsRelist = true;
      const text = errorText(err);
      this.logger.warn(`watch closed: ${text}`);
      this.setWatchHealth(false, text);
      this.scheduleRestart();
      return;
    }
    // A clean close is the apiserver's routine watch timeout. Resume from the
    // last observed resourceVersion instead of re-listing every object. The
    // small floor keeps a peer that closes instantly from becoming a spin loop.
    this.scheduleRestart(250);
  }

  private scheduleRestart(delayOverride?: number): void {
    if (this.stopped || this.restartTimer) return;
    let delay: number;
    if (delayOverride !== undefined) {
      delay = delayOverride;
    } else {
      delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.listThenWatch();
    }, delay);
    this.restartTimer.unref?.();
  }

  private normalize(raw: any): any {
    const obj = raw ?? {};
    obj.apiVersion = obj.apiVersion ?? this.config.apiVersion;
    obj.kind = obj.kind ?? this.config.kind;
    if (obj.metadata) {
      delete obj.metadata.managedFields;
      if (obj.metadata.annotations) {
        delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      }
    }
    return this.config.sanitize ? (this.config.sanitize(obj) ?? obj) : obj;
  }

  private toRow(obj: any, refs: EngineRefs): EngineRow {
    const resourceVersion = String(obj.metadata.resourceVersion ?? '');
    return {
      uid: obj.metadata.uid,
      apiVersion: this.config.apiVersion,
      kind: this.config.kind,
      namespace: obj.metadata.namespace ?? '',
      name: obj.metadata.name,
      resourceVersion,
      // Nothing derives from this kind, so holding the manifest is all there is
      // to do and the row is born fully applied.
      derivedVersion: this.config.onEvent ? null : resourceVersion,
      shard: this.shard,
      manifest: obj,
      refs
    };
  }

  private async writeRows(all: EngineRow[], since?: string): Promise<void> {
    if (all.length === 0) return;
    const byUid = new Map<string, EngineRow>();
    for (const row of all) byUid.set(row.uid, row);
    const rows = [...byUid.values()];

    try {
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        await this.store.write(rows.slice(i, i + WRITE_CHUNK), since);
      }
      this.setWriteHealth(true, null);
    } catch (err) {
      this.setWriteHealth(false, errorText(err));
      throw err;
    }
  }
}
