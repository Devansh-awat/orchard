import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { LeaseService } from '../coordination/lease.service';
import { parseImageRef, sameRegistryHost } from '../projects/image-ref';
import { platformRegistryApi, RegistryApi, RegistryError } from './registry-api';

export const REGISTRY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const REGISTRY_PRUNE_FIRST_DELAY_MS = 5 * 60 * 1000;
export const KEEP_NEWEST_BUILDS = 10;

const BUILD_TAG_RE = /^v\d{8}T\d{5}(?:-[0-9a-f]{12})?$/;

export function isBuildTag(tag: string): boolean {
  return BUILD_TAG_RE.test(tag);
}

export interface RepoKeep {
  tags: Set<string>;
  digests: Set<string>;
}

export interface PlatformImage {
  repository: string;
  tag: string | null;
  digest: string | null;
}

export function platformImage(
  image: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): PlatformImage | null {
  if (!image) return null;
  const ref = parseImageRef(image);
  if (!ref?.host) return null;
  const hosts = [env.DOCKER_REGISTRY_PULL, env.DOCKER_REGISTRY_PUSH].filter((h): h is string =>
    Boolean(h)
  );
  if (!hosts.some((host) => sameRegistryHost(ref.host!, host.replace(/^https?:\/\//, '')))) {
    return null;
  }
  const project = env.REGISTRY_PROJECT || 'orchard';
  const parts = ref.repository.split('/');
  if (parts.length !== 2 || parts[0] !== project || !parts[1]) return null;
  return { repository: ref.repository, tag: ref.tag, digest: ref.digest };
}

export function newestBuildTags(tags: string[], keep = KEEP_NEWEST_BUILDS): string[] {
  return tags.filter(isBuildTag).sort().slice(-keep);
}

export interface PruneResult {
  repository: string;
  deleted: string[];
  kept: number;
}

async function digestsOf(
  api: RegistryApi,
  repository: string,
  tags: Iterable<string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const tag of tags) {
    const digest = await api.digestOf(repository, tag);
    if (digest) out.set(tag, digest);
  }
  return out;
}

async function deleteUnshared(
  api: RegistryApi,
  repository: string,
  doomed: string[],
  survivors: string[],
  pinned: Set<string>
): Promise<string[]> {
  if (doomed.length === 0) return [];
  const keep = new Set(pinned);
  for (const digest of (await digestsOf(api, repository, survivors)).values()) keep.add(digest);
  const targets = new Set<string>();
  const shared: string[] = [];
  for (const [tag, digest] of await digestsOf(api, repository, doomed)) {
    if (keep.has(digest)) shared.push(tag);
    else targets.add(digest);
  }
  const deleted: string[] = [];
  for (const digest of targets) {
    await api.deleteManifest(repository, digest);
    deleted.push(digest);
  }
  for (const tag of shared) {
    await api.deleteTag(repository, tag).catch((err) => {
      if (!(err instanceof RegistryError) || err.kind === 'failed') throw err;
    });
  }
  return deleted;
}

export async function pruneRepository(
  api: RegistryApi,
  repository: string,
  keep: RepoKeep,
  newest = KEEP_NEWEST_BUILDS
): Promise<PruneResult> {
  const tags = await api.listTags(repository);
  const survivors = new Set<string>(newestBuildTags(tags, newest));
  for (const tag of tags) {
    if (!isBuildTag(tag) || keep.tags.has(tag)) survivors.add(tag);
  }
  const doomed = tags.filter((tag) => !survivors.has(tag));
  const deleted = await deleteUnshared(api, repository, doomed, [...survivors], keep.digests);
  return { repository, deleted, kept: survivors.size };
}

export async function deleteTags(
  api: RegistryApi,
  repository: string,
  tags: string[]
): Promise<string[]> {
  const doomedSet = new Set(tags);
  const present = await api.listTags(repository);
  const doomed = present.filter((tag) => doomedSet.has(tag));
  const survivors = present.filter((tag) => !doomedSet.has(tag));
  return deleteUnshared(api, repository, doomed, survivors, new Set());
}

@Injectable()
export class RegistryPruneService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistryPruneService.name);

  private running = false;

  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly lease: LeaseService
  ) {}

  onApplicationBootstrap(): void {
    this.leader.onAcquired(() => {
      setTimeout(() => {
        this.tick().catch(() => undefined);
      }, REGISTRY_PRUNE_FIRST_DELAY_MS).unref?.();
    });
  }

  @Interval(REGISTRY_PRUNE_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.lease.canCoordinate || !this.leader.isLeader() || this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (err) {
      this.report(err, 'registry sweep');
    } finally {
      this.running = false;
    }
  }

  pruneSoon(image: string): void {
    if (!this.lease.canCoordinate) return;
    const target = platformImage(image);
    if (!target || this.pending.has(target.repository)) return;
    const run = this.pruneOne(target.repository)
      .catch((err) => this.report(err, `pruning ${target.repository}`))
      .finally(() => this.pending.delete(target.repository));
    this.pending.set(target.repository, run);
  }

  async sweep(): Promise<PruneResult[]> {
    const api = platformRegistryApi();
    if (!api) return [];
    const { owned, keep } = await this.references();
    const results: PruneResult[] = [];
    let deleted = 0;
    for (const repository of owned) {
      try {
        const result = await pruneRepository(api, repository, keep.get(repository) ?? emptyKeep());
        results.push(result);
        deleted += result.deleted.length;
      } catch (err) {
        if (err instanceof RegistryError && err.kind !== 'failed') throw err;
        this.report(err, `pruning ${repository}`);
      }
    }
    this.logger.log(
      `registry sweep checked ${owned.length} repositories and deleted ${deleted} old images`
    );
    return results;
  }

  private async pruneOne(repository: string): Promise<void> {
    const api = platformRegistryApi();
    if (!api) return;
    const { keep } = await this.references(repository);
    const result = await pruneRepository(api, repository, keep.get(repository) ?? emptyKeep());
    if (result.deleted.length > 0) {
      this.logger.log(`deleted ${result.deleted.length} old images from ${repository}`);
    }
  }

  async references(only?: string): Promise<{ owned: string[]; keep: Map<string, RepoKeep> }> {
    const scope = only ? { contains: `/${only}` } : undefined;
    const [history, deployments, releases, workloads, steps] = await Promise.all([
      this.prisma.imageHistory.findMany({
        where: scope ? { image: scope } : undefined,
        select: { image: true }
      }),
      this.prisma.deployment.findMany({
        where: scope ? { image: scope } : { image: { not: null } },
        select: { image: true }
      }),
      this.prisma.release.findMany({
        where: { status: 'live', ...(scope ? { image: scope } : {}) },
        select: { image: true }
      }),
      this.prisma.k8sWorkload.findMany({
        where: scope ? { observedImage: scope } : { observedImage: { not: null } },
        select: { observedImage: true }
      }),
      this.prisma.jobStep.findMany({
        where: scope ? { image: scope } : { image: { not: null } },
        select: { image: true }
      })
    ]);

    const owned = new Set<string>();
    const keep = new Map<string, RepoKeep>();
    const add = (image: string | null, owns: boolean) => {
      const target = platformImage(image);
      if (!target) return;
      if (only && target.repository !== only) return;
      if (owns) owned.add(target.repository);
      let entry = keep.get(target.repository);
      if (!entry) keep.set(target.repository, (entry = emptyKeep()));
      if (target.tag) entry.tags.add(target.tag);
      if (target.digest) entry.digests.add(target.digest);
    };
    for (const row of history) add(row.image, true);
    for (const row of deployments) add(row.image, true);
    for (const row of releases) add(row.image, false);
    for (const row of workloads) add(row.observedImage, false);
    for (const row of steps) add(row.image, false);
    return { owned: [...owned].sort(), keep };
  }

  private report(err: unknown, what: string): void {
    if (err instanceof RegistryError && err.kind === 'denied') {
      const api = platformRegistryApi();
      this.logger.error(
        `${what} failed: the registry account ${api?.user ?? '(none)'} may not delete images (${err.message}). Grant it delete permission (on Harbor: Delete Artifact and Delete Tag on the robot account) or old images will fill the registry.`
      );
      return;
    }
    if (err instanceof RegistryError && err.kind === 'unsupported') {
      this.logger.error(
        `${what} failed: the registry refused to delete images (${err.message}). Enable deletes on the registry (for distribution, REGISTRY_STORAGE_DELETE_ENABLED=true).`
      );
      return;
    }
    this.logger.warn(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function emptyKeep(): RepoKeep {
  return { tags: new Set(), digests: new Set() };
}
