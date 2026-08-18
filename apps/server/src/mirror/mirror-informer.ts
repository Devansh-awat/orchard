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
}

export interface MirrorResourceConfig {
  kind: string;
  apiVersion: string;
  watchPath: string;
  labelSelector?: string;
  list(kc: k8s.KubeConfig, opts: MirrorListOptions): Promise<MirrorListPage>;
  mapRefs?(obj: any): Promise<MirrorRefs>;
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

// Rows written per INSERT ... ON CONFLICT. 13 params per row keeps a chunk well
// under Postgres' 65535 bind-parameter ceiling.
const WRITE_CHUNK = 100;

// How many watch events may be in flight at once. Events for the same object
// are always serialized (see `enqueue`); this only bounds cross-object fan-out
// so a mass rollout can't open hundreds of concurrent transactions.
const EVENT_CONCURRENCY = 12;

interface ObjectRow {
  uid: string;
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  resourceVersion: string;
  shard: string;
  manifest: unknown;
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
    private readonly hooks: MirrorInformerHooks,
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

  private async listAndSync(
    countRepairs: boolean,
  ): Promise<{ resourceVersion: string; repairs: number }> {
    const existingRows = await this.prisma.k8sObject.findMany({
      where: { shard: this.shard, kind: this.config.kind },
      select: { uid: true, resourceVersion: true },
    });
    const existingRv = new Map(existingRows.map((r) => [r.uid, r.resourceVersion]));

    const seenUids: string[] = [];
    const seenKeys: MirrorObjectKey[] = [];
    let repairs = 0;
    let resourceVersion = '';
    let continueToken: string | undefined;
    let pending: any[] = [];

    do {
      const page = await this.config.list(this.kc, {
        limit: LIST_PAGE_SIZE,
        continueToken,
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
        seenKeys.push({ namespace: obj.metadata.namespace ?? '', name: obj.metadata.name });
        if (existingRv.get(uid) === String(obj.metadata.resourceVersion ?? '')) continue;
        if (countRepairs) repairs += 1;
        pending.push(obj);
        if (pending.length >= WRITE_CHUNK) {
          await this.flush(pending);
          pending = [];
        }
      }
    } while (continueToken);

    if (pending.length > 0) await this.flush(pending);

    repairs += await this.sweepStale(seenUids, countRepairs);

    if (this.config.onListComplete) {
      await this.config.onListComplete(seenKeys).catch((err) => {
        this.logger.warn(`onListComplete failed: ${errorText(err)}`);
      });
    }

    return { resourceVersion, repairs };
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
        }
      }
    }
    return countRepairs ? stale.length : 0;
  }

  private async flush(objs: any[]): Promise<void> {
    try {
      await this.writeObjects(objs);
    } catch (err) {
      // A failed chunk leaves those rows stale until the next resync rather
      // than aborting the whole list — the seen set is still complete, so the
      // stale sweep downstream stays correct.
      this.logger.warn(`batch write of ${objs.length} objects failed: ${errorText(err)}`);
    }
    if (!this.config.onEvent) return;
    await Promise.all(
      objs.map((obj) =>
        this.sem.run(async () => {
          try {
            await this.config.onEvent!('update', obj);
          } catch (err) {
            this.logger.warn(
              `event handler failed for ${obj?.metadata?.name}: ${errorText(err)}`,
            );
          }
        }),
      ),
    );
  }

  private async startWatch(resourceVersion: string): Promise<void> {
    if (this.stopped) return;
    const watch = new k8s.Watch(this.kc);
    const queryParams: Record<string, unknown> = {
      allowWatchBookmarks: true,
      resourceVersion,
    };
    if (this.config.labelSelector) queryParams.labelSelector = this.config.labelSelector;

    this.req = await watch.watch(
      this.config.watchPath,
      queryParams,
      (phase, obj) => this.dispatch(phase, obj),
      (err) => this.onDone(err),
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
        this.logger.warn(`event handling failed for ${key}: ${errorText(err)}`);
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
    await this.writeObjects([obj]);
    if (this.config.onEvent) {
      await this.config.onEvent(phase === 'ADDED' ? 'add' : 'update', obj);
    }
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

  private async toRow(obj: any): Promise<ObjectRow> {
    let refs: MirrorRefs = {};
    if (this.config.mapRefs) {
      try {
        refs = await this.config.mapRefs(obj);
      } catch (err) {
        this.logger.warn(`mapRefs failed for ${obj?.metadata?.name}: ${errorText(err)}`);
      }
    }
    return {
      uid: obj.metadata.uid,
      apiVersion: this.config.apiVersion,
      kind: this.config.kind,
      namespace: obj.metadata.namespace ?? '',
      name: obj.metadata.name,
      resourceVersion: String(obj.metadata.resourceVersion ?? ''),
      shard: this.shard,
      manifest: obj,
      deploymentId: refs.deploymentId ?? null,
      projectId: refs.projectId ?? null,
      databaseId: refs.databaseId ?? null,
      jobId: refs.jobId ?? null,
    };
  }

  private async writeObjects(objs: any[]): Promise<void> {
    if (objs.length === 0) return;
    // A LIST never repeats a uid, but dedupe anyway: two rows with the same uid
    // in one statement makes ON CONFLICT fail with "cannot affect row a second
    // time".
    const byUid = new Map<string, any>();
    for (const obj of objs) byUid.set(obj.metadata.uid, obj);
    const rows = await Promise.all([...byUid.values()].map((obj) => this.toRow(obj)));

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
          Prisma.sql`(${r.kind}::varchar, ${r.namespace}::varchar, ${r.name}::varchar, ${r.apiVersion}::varchar, ${r.uid}::varchar)`,
      ),
    );
    const values = Prisma.join(
      rows.map(
        (r) => Prisma.sql`(
          ${r.uid}::varchar, ${r.apiVersion}::varchar, ${r.kind}::varchar, ${r.namespace}::varchar,
          ${r.name}::varchar, ${r.resourceVersion}::varchar, ${r.shard}::varchar,
          ${JSON.stringify(r.manifest)}::jsonb, ${r.deploymentId}::uuid, ${r.projectId}::uuid,
          ${r.databaseId}::uuid, ${r.jobId}::uuid, (NOW() AT TIME ZONE 'UTC')
        )`,
      ),
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
          "uid", "api_version", "kind", "namespace", "name", "resource_version", "shard",
          "manifest", "deployment_id", "project_id", "database_id", "job_id", "synced_at"
        )
        VALUES ${values}
        ON CONFLICT ("uid") DO UPDATE SET
          "api_version" = EXCLUDED."api_version",
          "kind" = EXCLUDED."kind",
          "namespace" = EXCLUDED."namespace",
          "name" = EXCLUDED."name",
          "resource_version" = EXCLUDED."resource_version",
          "shard" = EXCLUDED."shard",
          "manifest" = EXCLUDED."manifest",
          "deployment_id" = EXCLUDED."deployment_id",
          "project_id" = EXCLUDED."project_id",
          "database_id" = EXCLUDED."database_id",
          "job_id" = EXCLUDED."job_id",
          "synced_at" = EXCLUDED."synced_at"
      `,
    ]);
  }
}
