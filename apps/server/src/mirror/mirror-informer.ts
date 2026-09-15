import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';

export type MirrorEventType = 'add' | 'update' | 'delete';

export interface MirrorRefs {
  deploymentId?: string | null;
  projectId?: string | null;
  databaseId?: string | null;
  jobId?: string | null;
}

export interface MirrorListOptions {
  limit: number;
  continueToken?: string;
}

export interface MirrorListPage {
  items: any[];
  resourceVersion: string;
  continueToken?: string | null;
}

export interface MirrorObjectKey {
  namespace: string;
  name: string;
  // What this pass resolved the object's owners to, or null when resolution
  // failed. A pruner that sees a null knows its picture of the cluster is
  // incomplete and must not delete anything on the strength of it.
  refs: MirrorRefs | null;
}

export interface MirrorResourceConfig {
  kind: string;
  apiVersion: string;
  watchPath: string;
  labelSelector?: string;
  list(kc: k8s.KubeConfig, opts: MirrorListOptions): Promise<MirrorListPage>;
  // Resolve the Orchard rows an object belongs to. Returning `{}` means "it
  // belongs to nothing", which is a real answer and gets stored. Throwing means
  // "could not tell", which is not: the informer then leaves the row alone and
  // retries, rather than recording a mapping it does not actually have.
  mapRefs?(obj: any): Promise<MirrorRefs>;
  // Apply the object to whatever Orchard state derives from it. Must throw on
  // failure. A handler that swallows its own errors tells the informer the
  // version was applied when it was not, and nothing will ever come back for it.
  onEvent?(type: MirrorEventType, obj: any): void | Promise<void>;
  onListComplete?(seen: MirrorObjectKey[]): Promise<void>;
}

export interface MirrorInformerHooks {
  onListed(resourceVersion: string): void;
  onWatchEvent(): void;
  onHealthChange(healthy: boolean, error: string | null): void;
}

// Objects pulled per LIST page. Bounds peak memory on the initial sync: without
// it a cluster with tens of thousands of objects arrives as one response and one
// array of full manifests.
const LIST_PAGE_SIZE = 500;

// Rows written per INSERT ... ON CONFLICT. 14 params per row keeps a chunk well
// under Postgres' 65535 bind-parameter ceiling.
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

interface ObjectRow {
  uid: string;
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  resourceVersion: string;
  derivedVersion: string | null;
  shard: string;
  manifest: unknown;
  deploymentId: string | null;
  projectId: string | null;
  databaseId: string | null;
  jobId: string | null;
}

// An object on its way into the mirror, carrying the refs already resolved for
// it so nothing has to resolve them twice.
interface PendingWrite {
  obj: any;
  refs: MirrorRefs;
}

interface StoredRow {
  resourceVersion: string;
  derivedVersion: string | null;
  deploymentId: string | null;
  projectId: string | null;
  databaseId: string | null;
  jobId: string | null;
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

export class MirrorInformer {
  private readonly logger: Logger;

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

  private resourceVersion = '';

  private needsRelist = true;

  private watchOk = true;

  private writeOk = true;

  private healthy = true;

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly prisma: PrismaService,
    private readonly shard: string,
    private readonly config: MirrorResourceConfig,
    private readonly hooks: MirrorInformerHooks
  ) {
    this.logger = new Logger(`Mirror:${shard}/${config.kind}`);
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

    const existingRows = await this.prisma.k8sObject.findMany({
      where: { shard: this.shard, kind: this.config.kind },
      select: {
        uid: true,
        resourceVersion: true,
        derivedVersion: true,
        deploymentId: true,
        projectId: true,
        databaseId: true,
        jobId: true
      }
    });
    const existing = new Map(existingRows.map((r) => [r.uid, r]));

    const seenUids: string[] = [];
    const seenKeys: MirrorObjectKey[] = [];
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
            await this.derive('update', underived);
            underived = [];
          }
          continue;
        }
        pending.push({ obj, refs: resolved.refs });
        if (pending.length >= WRITE_CHUNK) {
          await this.flush(pending);
          pending = [];
        }
      }
    } while (continueToken);

    if (pending.length > 0) await this.flush(pending);
    if (underived.length > 0) await this.derive('update', underived);

    repairs += await this.sweepStale(seenUids, countRepairs);

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
    refs: MirrorRefs
  ): 'current' | 'underived' | 'stale' {
    if (!prior) return 'stale';
    const rv = String(obj.metadata.resourceVersion ?? '');
    if (prior.resourceVersion !== rv) return 'stale';
    const sameRefs =
      (prior.deploymentId ?? null) === (refs.deploymentId ?? null) &&
      (prior.projectId ?? null) === (refs.projectId ?? null) &&
      (prior.databaseId ?? null) === (refs.databaseId ?? null) &&
      (prior.jobId ?? null) === (refs.jobId ?? null);
    if (!sameRefs) return 'stale';
    return prior.derivedVersion === rv ? 'current' : 'underived';
  }

  private async resolveRefs(obj: any): Promise<{ ok: boolean; refs: MirrorRefs }> {
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

  // Delete everything this shard holds for this kind that the cluster no longer
  // reports. `= ANY($1)` binds the whole set as a single array parameter — an
  // `IN (...)` list would bind one parameter per object and fall off the
  // 65535-parameter cliff on a large cluster.
  private async sweepStale(seenUids: string[], countRepairs: boolean): Promise<number> {
    const stale = await this.prisma.$queryRaw<{ uid: string; manifest: any }[]>`
      DELETE FROM "k8s_objects"
      WHERE "shard" = ${this.shard}
        AND "kind" = ${this.config.kind}
        AND NOT ("uid" = ANY(${seenUids}::varchar[]))
      RETURNING "uid", "manifest"
    `;
    if (this.config.onEvent) {
      for (const row of stale) {
        try {
          await this.config.onEvent('delete', row.manifest);
        } catch (err) {
          this.logger.warn(`delete handler failed for ${row.uid}: ${errorText(err)}`);
          this.scheduleRepair();
        }
      }
    }
    return countRepairs ? stale.length : 0;
  }

  private async flush(entries: PendingWrite[]): Promise<void> {
    try {
      await this.writeRows(entries.map((e) => this.toRow(e.obj, e.refs)));
    } catch (err) {
      // A failed chunk leaves those rows behind rather than aborting the whole
      // list — the seen set is still complete, so the stale sweep downstream
      // stays correct, and the rows keep their old resourceVersion so the next
      // pass comes back for them.
      this.logger.warn(`batch write of ${entries.length} objects failed: ${errorText(err)}`);
      this.scheduleRepair();
      return;
    }
    await this.derive('update', entries);
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
   */
  private async derive(type: MirrorEventType, entries: PendingWrite[]): Promise<void> {
    if (!this.config.onEvent || entries.length === 0) return;
    const applied = await Promise.all(
      entries.map((entry) =>
        this.sem.run(async () => {
          try {
            await this.config.onEvent!(type, entry.obj);
            return entry;
          } catch (err) {
            this.logger.warn(
              `event handler failed for ${entry.obj?.metadata?.name}: ${errorText(err)}`
            );
            return null;
          }
        })
      )
    );
    const ok = applied.filter((entry): entry is PendingWrite => entry !== null);
    if (ok.length < entries.length) this.scheduleRepair();
    await this.markDerived(ok);
  }

  private async markDerived(entries: PendingWrite[]): Promise<void> {
    if (entries.length === 0) return;
    const uids = entries.map((e) => String(e.obj.metadata.uid));
    const versions = entries.map((e) => String(e.obj.metadata.resourceVersion ?? ''));
    try {
      // Matching on resource_version too, so a newer manifest that landed while
      // the handler ran is not credited with a derivation it never got.
      await this.prisma.$executeRaw`
        UPDATE "k8s_objects" AS o
        SET "derived_version" = v."rv"
        FROM unnest(${uids}::varchar[], ${versions}::varchar[]) AS v("uid", "rv")
        WHERE o."uid" = v."uid" AND o."resource_version" = v."rv"
      `;
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
      await this.prisma.k8sObject.delete({ where: { uid: obj.metadata.uid } }).catch(() => {});
      if (this.config.onEvent) await this.config.onEvent('delete', obj);
      return;
    }

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
    await this.derive(phase === 'ADDED' ? 'add' : 'update', [{ obj, refs: resolved.refs }]);
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
    return obj;
  }

  private toRow(obj: any, refs: MirrorRefs): ObjectRow {
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
      deploymentId: refs.deploymentId ?? null,
      projectId: refs.projectId ?? null,
      databaseId: refs.databaseId ?? null,
      jobId: refs.jobId ?? null
    };
  }

  private async writeRows(all: ObjectRow[]): Promise<void> {
    if (all.length === 0) return;
    // A LIST never repeats a uid, but dedupe anyway: two rows with the same uid
    // in one statement makes ON CONFLICT fail with "cannot affect row a second
    // time".
    const byUid = new Map<string, ObjectRow>();
    for (const row of all) byUid.set(row.uid, row);
    const rows = [...byUid.values()];

    try {
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        await this.writeChunk(rows.slice(i, i + WRITE_CHUNK));
      }
      this.setWriteHealth(true, null);
    } catch (err) {
      this.setWriteHealth(false, errorText(err));
      throw err;
    }
  }

  private async writeChunk(rows: ObjectRow[]): Promise<void> {
    // `k8s_objects` is keyed by uid but also carries a unique index on the
    // natural key. Deleting a resource and recreating it under the same name
    // yields a new uid for the same natural key, so the upsert-by-uid alone
    // would trip that index and wedge the informer. Clear the displaced row in
    // the same transaction as the insert.
    const naturalKeys = Prisma.join(
      rows.map(
        (r) =>
          Prisma.sql`(${r.kind}::varchar, ${r.namespace}::varchar, ${r.name}::varchar, ${r.apiVersion}::varchar, ${r.uid}::varchar)`
      )
    );
    const values = Prisma.join(
      rows.map(
        (r) => Prisma.sql`(
          ${r.uid}::varchar, ${r.apiVersion}::varchar, ${r.kind}::varchar, ${r.namespace}::varchar,
          ${r.name}::varchar, ${r.resourceVersion}::varchar, ${r.derivedVersion}::varchar,
          ${r.shard}::varchar,
          ${JSON.stringify(r.manifest)}::jsonb, ${r.deploymentId}::uuid, ${r.projectId}::uuid,
          ${r.databaseId}::uuid, ${r.jobId}::uuid, (NOW() AT TIME ZONE 'UTC')
        )`
      )
    );

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        DELETE FROM "k8s_objects" AS o
        USING (VALUES ${naturalKeys}) AS v("kind", "namespace", "name", "api_version", "uid")
        WHERE o."kind" = v."kind"
          AND o."namespace" = v."namespace"
          AND o."name" = v."name"
          AND o."api_version" = v."api_version"
          AND o."uid" <> v."uid"
      `,
      this.prisma.$executeRaw`
        INSERT INTO "k8s_objects" (
          "uid", "api_version", "kind", "namespace", "name", "resource_version",
          "derived_version", "shard",
          "manifest", "deployment_id", "project_id", "database_id", "job_id", "synced_at"
        )
        VALUES ${values}
        ON CONFLICT ("uid") DO UPDATE SET
          "api_version" = EXCLUDED."api_version",
          "kind" = EXCLUDED."kind",
          "namespace" = EXCLUDED."namespace",
          "name" = EXCLUDED."name",
          "resource_version" = EXCLUDED."resource_version",
          "derived_version" = EXCLUDED."derived_version",
          "shard" = EXCLUDED."shard",
          "manifest" = EXCLUDED."manifest",
          "deployment_id" = EXCLUDED."deployment_id",
          "project_id" = EXCLUDED."project_id",
          "database_id" = EXCLUDED."database_id",
          "job_id" = EXCLUDED."job_id",
          "synced_at" = EXCLUDED."synced_at"
      `
    ]);
  }
}
