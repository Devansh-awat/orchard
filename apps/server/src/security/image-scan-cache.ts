import {
  MAX_VULNERABILITIES,
  blankSummary,
  mapVulnerabilities,
  pickOverview,
  summarizeScan,
  type HarborArtifact,
  type HarborImageRef,
  type ScanReason,
  type ScanSummary,
  type Vulnerability
} from './security-report';
import type { HarborScanError } from './harbor-scan.client';

export interface ScanSource {
  artifact(ref: HarborImageRef): Promise<HarborArtifact>;
  vulnerabilities(ref: HarborImageRef): Promise<unknown>;
  scan(ref: HarborImageRef): Promise<'started' | 'already_running'>;
}

export interface ImageScan {
  summary: ScanSummary;
  vulnerabilities: Vulnerability[] | null;
  truncated: number;
  digest: string | null;
  pushedAt: string | null;
}

export const SCAN_TTL = {
  settled: 10 * 60_000,
  scanning: 4_000,
  error: 30_000
};

export const RESCAN_COOLDOWN_MS = 30_000;
const PENDING_GRACE_MS = 20_000;
const MAX_ENTRIES = 500;

const FAILURE_REASON: Record<HarborScanError['kind'], ScanReason> = {
  not_found: 'not_found',
  unauthorized: 'unauthorized',
  unreachable: 'unreachable',
  not_scannable: 'not_scannable'
};

function keyOf(ref: HarborImageRef): string {
  return `${ref.repository}@${ref.reference}`;
}

function failureOf(err: unknown): ScanReason {
  const kind = (err as HarborScanError)?.kind;
  return (kind && FAILURE_REASON[kind]) || 'unreachable';
}

export class ImageScanCache {
  private readonly entries = new Map<string, { at: number; ttl: number; value: ImageScan }>();
  private readonly inflight = new Map<string, Promise<ImageScan>>();
  private readonly requested = new Map<string, number>();

  constructor(
    private readonly source: ScanSource,
    private readonly now: () => number = Date.now
  ) {}

  async get(ref: HarborImageRef): Promise<ImageScan> {
    const key = keyOf(ref);
    const hit = this.entries.get(key);
    const value = hit && this.now() - hit.at < hit.ttl ? hit.value : await this.load(key, ref);
    return this.withPendingRequest(key, value);
  }

  async rescan(ref: HarborImageRef): Promise<ImageScan> {
    const key = keyOf(ref);
    const last = this.requested.get(key) ?? 0;
    if (this.now() - last >= RESCAN_COOLDOWN_MS) {
      await this.source.scan(ref);
      this.requested.set(key, this.now());
      this.entries.delete(key);
    }
    return this.get(ref);
  }

  private withPendingRequest(key: string, value: ImageScan): ImageScan {
    const at = this.requested.get(key);
    if (!at || this.now() - at > PENDING_GRACE_MS) return value;
    const s = value.summary;
    if (s.state === 'scanning' || s.state === 'error' || s.state === 'unsupported') return value;
    const finished = s.finishedAt ? Date.parse(s.finishedAt) : 0;
    if (finished >= at) return value;
    return {
      ...value,
      summary: { ...blankSummary('scanning'), progress: 0, scanner: s.scanner },
      vulnerabilities: null,
      truncated: 0
    };
  }

  private load(key: string, ref: HarborImageRef): Promise<ImageScan> {
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.fetch(ref)
      .then(({ value, ttl }) => {
        this.store(key, value, ttl);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private store(key: string, value: ImageScan, ttl: number) {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), ttl, value });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private async fetch(ref: HarborImageRef): Promise<{ value: ImageScan; ttl: number }> {
    let artifact: HarborArtifact;
    try {
      artifact = await this.source.artifact(ref);
    } catch (err) {
      const reason = failureOf(err);
      const state = reason === 'not_scannable' ? 'unsupported' : 'error';
      return {
        value: {
          summary: blankSummary(state, reason),
          vulnerabilities: null,
          truncated: 0,
          digest: null,
          pushedAt: null
        },
        ttl: SCAN_TTL.error
      };
    }

    const summary = summarizeScan(pickOverview(artifact));
    const base = {
      digest: artifact.digest ?? null,
      pushedAt: artifact.push_time ?? null
    };
    if (summary.state === 'scanning') {
      return {
        value: { ...base, summary, vulnerabilities: null, truncated: 0 },
        ttl: SCAN_TTL.scanning
      };
    }
    if (summary.state !== 'vulnerable') {
      return {
        value: {
          ...base,
          summary,
          vulnerabilities: summary.state === 'clean' ? [] : null,
          truncated: 0
        },
        ttl: SCAN_TTL.settled
      };
    }

    try {
      const all = mapVulnerabilities(await this.source.vulnerabilities(ref));
      return {
        value: {
          ...base,
          summary,
          vulnerabilities: all.slice(0, MAX_VULNERABILITIES),
          truncated: Math.max(0, all.length - MAX_VULNERABILITIES)
        },
        ttl: SCAN_TTL.settled
      };
    } catch {
      return {
        value: { ...base, summary, vulnerabilities: null, truncated: 0 },
        ttl: SCAN_TTL.error
      };
    }
  }
}
