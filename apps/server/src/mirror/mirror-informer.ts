import { Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';

export type MirrorEventType = 'add' | 'update' | 'delete';

export interface MirrorRefs {
  deploymentId?: string | null;
  projectId?: string | null;
  databaseId?: string | null;
  jobId?: string | null;
}

export interface MirrorResourceConfig {
  kind: string;
  apiVersion: string;
  watchPath: string;
  labelSelector?: string;
  list(kc: k8s.KubeConfig): Promise<{ items: any[]; resourceVersion: string }>;
  mapRefs?(obj: any): Promise<MirrorRefs>;
  onEvent?(type: MirrorEventType, obj: any): void | Promise<void>;
}

export interface MirrorInformerHooks {
  onListed(resourceVersion: string): void;
  onWatchEvent(): void;
}

export class MirrorInformer {
  private readonly logger: Logger;

  private req?: { abort(): void };

  private backoffMs = 1000;

  private stopped = true;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private chain: Promise<void> = Promise.resolve();

  private connectedAt = 0;

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
    await this.chain.catch(() => {});
  }

  async resync(): Promise<number> {
    if (this.stopped) return 0;
    try {
      const { repairs } = await this.listAndSync(true);
      return repairs;
    } catch (err) {
      this.logger.warn(`resync failed: ${(err as Error)?.message ?? err}`);
      return 0;
    }
  }

  private async listThenWatch(): Promise<void> {
    if (this.stopped) return;
    try {
      const { resourceVersion } = await this.listAndSync(false);
      this.hooks.onListed(resourceVersion);
      await this.startWatch(resourceVersion);
      this.connectedAt = Date.now();
    } catch (err) {
      this.logger.warn(`list+watch failed: ${(err as Error)?.message ?? err}`);
      this.scheduleRestart();
    }
  }

  private async listAndSync(countRepairs: boolean): Promise<{ resourceVersion: string; repairs: number }> {
    const { items, resourceVersion } = await this.config.list(this.kc);
    const seen: string[] = [];
    let repairs = 0;

    const existingRows = await this.prisma.k8sObject.findMany({
      where: { shard: this.shard, kind: this.config.kind },
      select: { uid: true, resourceVersion: true },
    });
    const existingRv = new Map(existingRows.map((r) => [r.uid, r.resourceVersion]));

    for (const raw of items) {
      const obj = this.normalize(raw);
      const uid = obj.metadata?.uid;
      if (!uid) continue;
      seen.push(uid);
      if (existingRv.get(uid) === String(obj.metadata.resourceVersion ?? '')) continue;
      if (countRepairs) repairs += 1;
      await this.upsertObject(obj);
      if (this.config.onEvent) await this.config.onEvent('update', obj);
    }

    const stale = await this.prisma.k8sObject.findMany({
      where: { shard: this.shard, kind: this.config.kind, uid: { notIn: seen } },
      select: { uid: true, manifest: true },
    });
    for (const row of stale) {
      repairs += countRepairs ? 1 : 0;
      await this.prisma.k8sObject.delete({ where: { uid: row.uid } }).catch(() => {});
      if (this.config.onEvent) await this.config.onEvent('delete', row.manifest);
    }

    return { resourceVersion, repairs };
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
      (phase, obj) => {
        this.chain = this.chain
          .then(() => this.onWatchEvent(phase, obj))
          .catch((err) => {
            this.logger.warn(`event handling failed: ${(err as Error)?.message ?? err}`);
          });
      },
      (err) => this.onDone(err),
    );
  }

  private async onWatchEvent(phase: string, raw: any): Promise<void> {
    if (this.stopped) return;
    if (phase === 'BOOKMARK') return;
    if (phase === 'ERROR') {
      this.logger.warn(`watch error event: ${JSON.stringify(raw?.code ?? raw?.message ?? raw)}`);
      return;
    }
    const obj = this.normalize(raw);
    if (!obj.metadata?.uid) return;
    this.hooks.onWatchEvent();

    if (phase === 'DELETED') {
      await this.prisma.k8sObject.delete({ where: { uid: obj.metadata.uid } }).catch(() => {});
      if (this.config.onEvent) await this.config.onEvent('delete', obj);
      return;
    }
    await this.upsertObject(obj);
    if (this.config.onEvent) {
      await this.config.onEvent(phase === 'ADDED' ? 'add' : 'update', obj);
    }
  }

  private onDone(err: unknown): void {
    if (this.stopped) return;
    if (Date.now() - this.connectedAt > 60_000) this.backoffMs = 1000;
    if (err) {
      this.logger.warn(`watch closed: ${(err as Error)?.message ?? err}`);
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
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

  private async upsertObject(obj: any): Promise<void> {
    const refs = this.config.mapRefs ? await this.config.mapRefs(obj) : {};
    const data = {
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
    await this.prisma.k8sObject.upsert({
      where: { uid: obj.metadata.uid },
      create: { uid: obj.metadata.uid, ...data },
      update: data,
    });
  }
}
