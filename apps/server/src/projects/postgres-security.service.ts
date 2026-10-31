import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { PostgresImageService } from '../kubernetes/postgres-image.service';
import { FALLBACK_POSTGRES_IMAGES } from '../kubernetes/postgres-images';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { gauge } from '../analytics/datadog';
import {
  securityReport,
  versionFromImage,
  parseAdvisories,
  parseReleases,
  POSTGRES_SECURITY_URL,
  POSTGRES_VERSIONS_URL,
  type PostgresAdvisory,
  type PostgresRelease
} from '../kubernetes/postgres-advisories';

const ADVISORIES_KEY = 'postgres_advisories';
const REFRESH_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface AdvisoryCache {
  advisories: PostgresAdvisory[];
  releases: PostgresRelease[];
  fetchedAt: string;
}

export interface OfferedVersion {
  major: number;
  image: string;
  minor: number | null;
  supported: boolean | null;
  current: boolean;
  eolDate: string | null;
}

@Injectable()
export class PostgresSecurityService {
  private readonly logger = new Logger(PostgresSecurityService.name);

  private cache: AdvisoryCache | null = null;

  private lastRefresh = 0;

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly leader: LeaderElectionService,
    @Optional() private readonly images?: PostgresImageService,
    @Optional() private readonly k8sCnpg?: K8sCnpgService
  ) {}

  @Interval(60 * 60 * 1000)
  async tick() {
    if (!this.leader.isLeader()) return;
    if (Date.now() - this.lastRefresh >= REFRESH_MS) await this.refresh();
    await this.emitFleetGauges().catch((e) =>
      this.logger.warn(`postgres security gauges failed: ${e?.message ?? e}`)
    );
  }

  private async emitFleetGauges() {
    const cache = await this.load();
    if (!cache || !this.k8sCnpg) return;
    for (const g of securityGauges(
      await this.k8sCnpg.listAllCnpgClusters(),
      cache.advisories,
      cache.releases
    )) {
      gauge(g.metric, g.value, g.tags);
    }
  }

  async refresh(): Promise<AdvisoryCache | null> {
    this.lastRefresh = Date.now();
    try {
      const [html, versions] = await Promise.all([
        fetch(POSTGRES_SECURITY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(
          (r) => {
            if (!r.ok) throw new Error(`advisories HTTP ${r.status}`);
            return r.text();
          }
        ),
        fetch(POSTGRES_VERSIONS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(
          (r) => {
            if (!r.ok) throw new Error(`versions HTTP ${r.status}`);
            return r.json();
          }
        )
      ]);
      const advisories = parseAdvisories(html);
      const releases = parseReleases(versions);
      if (advisories.length === 0 || releases.length === 0) throw new Error('nothing parsed');
      const next: AdvisoryCache = { advisories, releases, fetchedAt: new Date().toISOString() };
      await this.settings.set(ADVISORIES_KEY, JSON.stringify(next));
      this.cache = next;
      return next;
    } catch (e: any) {
      this.logger.warn(`postgres advisories refresh failed: ${e?.message ?? e}`);
      return this.load();
    }
  }

  async load(): Promise<AdvisoryCache | null> {
    if (this.cache) return this.cache;
    const raw = await this.settings.get(ADVISORIES_KEY).catch(() => null);
    if (raw) {
      try {
        this.cache = JSON.parse(raw) as AdvisoryCache;
      } catch {
        this.cache = null;
      }
    }
    if (!this.cache && Date.now() - this.lastRefresh > 5 * 60 * 1000) return this.refresh();
    return this.cache;
  }

  catalogImages(): Record<number, string> {
    const channel = this.images?.currentChannel();
    return channel && Object.keys(channel.images).length
      ? channel.images
      : { ...FALLBACK_POSTGRES_IMAGES };
  }

  async offeredVersions(): Promise<{
    versions: OfferedVersion[];
    defaultMajor: number;
    source: string | null;
    catalogDate: string | null;
  }> {
    const images = this.catalogImages();
    const releases = (await this.load())?.releases ?? [];
    const versions = Object.entries(images)
      .map(([m, image]) => {
        const major = Number(m);
        const release = releases.find((r) => r.major === major);
        const minor = /:(\d+)\.(\d+)/.exec(image)?.[2];
        return {
          major,
          image,
          minor: minor !== undefined ? Number(minor) : null,
          supported: release ? release.supported : null,
          current: release?.current ?? false,
          eolDate: release?.eolDate ?? null
        };
      })
      .sort((a, b) => b.major - a.major);
    const channel = this.images?.currentChannel();
    return {
      versions,
      defaultMajor: defaultMajor(versions),
      source: channel?.source ?? null,
      catalogDate: channel?.catalogDate ?? null
    };
  }
}

export function defaultMajor(
  versions: { major: number; supported: boolean | null }[],
  env = process.env
): number {
  const pinned = Number.parseInt(env.POSTGRES_DEFAULT_MAJOR ?? '', 10);
  if (Number.isInteger(pinned) && versions.some((v) => v.major === pinned)) return pinned;
  const usable = versions.filter((v) => v.supported !== false).map((v) => v.major);
  return usable.length ? Math.max(...usable) : Math.max(...versions.map((v) => v.major), 17);
}

export function securityGauges(
  clusters: any[],
  advisories: PostgresAdvisory[],
  releases: PostgresRelease[],
  now = Date.now()
): { metric: string; value: number; tags: string[] }[] {
  const out: { metric: string; value: number; tags: string[] }[] = [];
  for (const c of clusters) {
    const version = versionFromImage(c?.status?.image ?? c?.spec?.imageName);
    if (!version || version.minor === null) continue;
    const report = securityReport(version, advisories, releases, now);
    const tags = [
      `kube_namespace:${c.metadata?.namespace}`,
      `cnpg_cluster:${c.metadata?.name}`,
      `pg_major:${version.major}`
    ];
    out.push({ metric: 'orchard.postgres.cve_max_score', value: report.highestScore ?? 0, tags });
    out.push({ metric: 'orchard.postgres.cves', value: report.vulnerabilities.length, tags });
    if (report.eolDate) {
      out.push({
        metric: 'orchard.postgres.days_to_eol',
        value: Math.round((Date.parse(report.eolDate) - now) / 86_400_000),
        tags
      });
    }
  }
  return out;
}
