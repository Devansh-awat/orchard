import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { k8sErrorMessage } from './k8s-error';
import { majorFromImage } from './cnpg-spec-sync';
import { gauge } from '../analytics/datadog';
import {
  clusterSettled,
  DEFAULT_POSTGRES_IMAGE_CATALOG_URL,
  hourInWindow,
  ImageRolloutCandidate,
  isOutdated,
  parseHourWindow,
  parsePostgresImageCatalog,
  pickImageRolloutBatch,
  POSTGRES_IMAGE_REPOSITORY,
  PostgresImageChannel,
  resolvePostgresImage,
  validPostgresImages
} from './postgres-images';

export const POSTGRES_IMAGE_CHANNEL_KEY = 'postgres_image_channel';
export const POSTGRES_IMAGE_ROLLOUT_HALT_KEY = 'postgres_image_rollout_halt';
export const PG_COLLATION_ANNOTATION = 'orchard.my/pg-collation';

const REFRESH_EVERY_MS = 6 * 60 * 60_000;
const ROLLOUT_EVERY_MS = 10 * 60_000;
const SETTLE_WITHIN_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_ROLLOUT_WINDOW: [number, number] = [8, 11];
const DEFAULT_ROLLOUT_BATCH = 3;
const ACTIVE_BACKUP_PHASES = new Set(['pending', 'started', 'running']);

interface PatchedCluster {
  namespace: string;
  clusterName: string;
  target: string;
  at: number;
}

export interface ImageRolloutResult {
  outdated: number;
  patched: string[];
  held: string[];
  halted: string | null;
}

@Injectable()
export class PostgresImageService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PostgresImageService.name);

  private channel: PostgresImageChannel | null = null;

  private lastBatch: PatchedCluster[] = [];

  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];

  private rolling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
    private readonly k8sCnpg: K8sCnpgService
  ) {}

  async onApplicationBootstrap() {
    await this.loadChannel().catch(() => {});
    const later = (fn: () => Promise<unknown>, ms: number) => {
      const t = setTimeout(() => fn().catch(() => {}), ms);
      t.unref?.();
      this.timers.push(t);
    };
    const every = (fn: () => Promise<unknown>, ms: number) => {
      const t = setInterval(() => fn().catch(() => {}), ms);
      t.unref?.();
      this.timers.push(t);
    };
    later(() => this.refresh(), 60_000);
    every(() => this.refresh(), REFRESH_EVERY_MS);
    every(() => this.rolloutTick(), ROLLOUT_EVERY_MS);
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t as any);
  }

  imageFor(major: number): string {
    return resolvePostgresImage(major, this.channel);
  }

  currentChannel(): PostgresImageChannel | null {
    return this.channel;
  }

  private catalogUrl(): string {
    return process.env.POSTGRES_IMAGE_CATALOG_URL?.trim() || DEFAULT_POSTGRES_IMAGE_CATALOG_URL;
  }

  async loadChannel(): Promise<void> {
    const raw = await this.settings.get(POSTGRES_IMAGE_CHANNEL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PostgresImageChannel;
    const images = validPostgresImages(parsed.images ?? {});
    if (Object.keys(images).length) this.channel = { ...parsed, images };
  }

  async refresh(): Promise<PostgresImageChannel | null> {
    await this.loadChannel().catch(() => {});
    if (!this.k8sCnpg.canRunClusterWide()) return this.channel;
    const url = this.catalogUrl();
    if (url === 'off') return this.channel;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parsePostgresImageCatalog(await res.text());
      const images = validPostgresImages(
        parsed.images,
        url === DEFAULT_POSTGRES_IMAGE_CATALOG_URL ? { repository: POSTGRES_IMAGE_REPOSITORY } : {}
      );
      if (!Object.keys(images).length) throw new Error('no usable images in the catalog');
      const unchanged =
        !!this.channel && JSON.stringify(this.channel.images) === JSON.stringify(images);
      const next: PostgresImageChannel = {
        images,
        source: url,
        catalogDate: parsed.catalogDate,
        fetchedAt: new Date().toISOString()
      };
      await this.settings.set(POSTGRES_IMAGE_CHANNEL_KEY, JSON.stringify(next));
      this.channel = next;
      if (!unchanged) {
        this.logger.log(
          `postgres image channel now ${parsed.catalogDate ?? 'undated'} from ${url}: ${Object.entries(
            images
          )
            .map(([m, i]) => `${m}=${i.split('@')[0].split(':').pop()}`)
            .join(' ')}`
        );
      }
    } catch (e: any) {
      this.logger.warn(`postgres image catalog refresh from ${url} failed: ${e?.message ?? e}`);
    }
    return this.channel;
  }

  private rolloutBatchSize(): number {
    const n = Number(process.env.POSTGRES_IMAGE_ROLLOUT_BATCH);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_ROLLOUT_BATCH;
  }

  async rolloutTick(now: Date = new Date()): Promise<ImageRolloutResult | null> {
    if (this.rolling || !this.k8sCnpg.canRunClusterWide()) return null;
    this.rolling = true;
    try {
      return await this.rollout(now);
    } finally {
      this.rolling = false;
    }
  }

  private async rollout(now: Date): Promise<ImageRolloutResult | null> {
    if (!(await this.settings.isPostgresAutoUpdateEnabled())) return null;
    const halted = await this.settings.get(POSTGRES_IMAGE_ROLLOUT_HALT_KEY);
    gauge('orchard.cnpg.image_rollout_halted', halted ? 1 : 0);
    const result: ImageRolloutResult = { outdated: 0, patched: [], held: [], halted };
    if (halted) return result;

    const [rows, clusters, backups] = await Promise.all([
      this.prisma.database.findMany({
        where: {
          mode: 'cnpg',
          namespace: { not: null },
          clusterName: { not: null },
          status: { notIn: ['deleting', 'restoring', 'error'] }
        },
        select: { namespace: true, clusterName: true, pgMajor: true }
      }),
      this.k8sCnpg.listAllCnpgClusters(),
      this.k8sCnpg.listAllCnpgBackups()
    ]);
    const byName = new Map<string, any>();
    for (const c of clusters) byName.set(`${c.metadata?.namespace}/${c.metadata?.name}`, c);

    if (this.lastBatch.length) {
      const pending: PatchedCluster[] = [];
      for (const p of this.lastBatch) {
        const cluster = byName.get(`${p.namespace}/${p.clusterName}`);
        if (!cluster || clusterSettled(cluster, p.target)) continue;
        if (now.getTime() - p.at < SETTLE_WITHIN_MS) {
          pending.push(p);
          continue;
        }
        const reason = `${p.namespace}/${p.clusterName} was not healthy on ${p.target} ${Math.round((now.getTime() - p.at) / 60_000)}m after the image change`;
        await this.settings.set(POSTGRES_IMAGE_ROLLOUT_HALT_KEY, reason);
        gauge('orchard.cnpg.image_rollout_halted', 1);
        this.logger.error(`postgres image rollout halted: ${reason}`);
        this.lastBatch = [];
        return { ...result, halted: reason };
      }
      this.lastBatch = pending;
      if (pending.length) return result;
    }

    const activeBackups = new Set<string>();
    for (const b of backups) {
      if (ACTIVE_BACKUP_PHASES.has(String(b.status?.phase ?? 'pending'))) {
        activeBackups.add(`${b.metadata?.namespace}/${b.spec?.cluster?.name}`);
      }
    }

    const candidates: ImageRolloutCandidate[] = [];
    for (const row of rows) {
      const key = `${row.namespace}/${row.clusterName}`;
      const cluster = byName.get(key);
      const current = typeof cluster?.spec?.imageName === 'string' ? cluster.spec.imageName : null;
      if (!cluster || !current) continue;
      const major = majorFromImage(current) ?? row.pgMajor;
      const collation = cluster.metadata?.annotations?.[PG_COLLATION_ANNOTATION];
      candidates.push({
        namespace: row.namespace!,
        clusterName: row.clusterName!,
        current,
        target: this.imageFor(major),
        healthy: clusterSettled(cluster, current),
        hibernated: cluster.metadata?.annotations?.['cnpg.io/hibernation'] === 'on',
        backupRunning: activeBackups.has(key),
        collation: collation === 'c' || collation === 'other' ? collation : null
      });
    }
    result.outdated = candidates.filter((c) => isOutdated(c)).length;
    gauge('orchard.cnpg.image_outdated', result.outdated);

    const window = parseHourWindow(
      process.env.POSTGRES_IMAGE_ROLLOUT_WINDOW,
      DEFAULT_ROLLOUT_WINDOW
    );
    if (!hourInWindow(now.getUTCHours(), window)) return result;

    const limit = this.rolloutBatchSize();
    let probes = 0;
    for (const c of pickImageRolloutBatch(candidates, candidates.length)) {
      if (result.patched.length >= limit || probes >= limit * 3) break;
      const key = `${c.namespace}/${c.clusterName}`;
      try {
        let collation = c.collation;
        if (!collation) {
          probes += 1;
          collation = await this.k8sCnpg.probeClusterCollation(c.namespace, byName.get(key));
          if (collation) {
            await this.k8sCnpg.annotateCnpgCluster(c.namespace, c.clusterName, {
              [PG_COLLATION_ANNOTATION]: collation
            });
          }
        }
        if (collation !== 'c') {
          result.held.push(key);
          this.logger.warn(
            `postgres image update held for ${key}: ${collation === 'other' ? 'a database uses a non-C collation, which a new OS image can reorder' : 'collation could not be checked'}`
          );
          continue;
        }
        await this.k8sCnpg.patchClusterImage(c.namespace, c.clusterName, c.target);
        this.lastBatch.push({
          namespace: c.namespace,
          clusterName: c.clusterName,
          target: c.target,
          at: now.getTime()
        });
        result.patched.push(key);
        this.logger.log(`postgres image for ${key}: ${c.current} -> ${c.target}`);
      } catch (e: any) {
        this.logger.warn(`postgres image update for ${key} failed: ${k8sErrorMessage(e)}`);
      }
    }
    return result;
  }
}
