import { Injectable } from '@nestjs/common';
import {
  REPORT_MIME_TYPES,
  encodeRepository,
  type HarborArtifact,
  type HarborImageRef,
  type ImageRegistryConfig
} from './security-report';

export type HarborFailure = 'not_found' | 'unauthorized' | 'unreachable' | 'not_scannable';

export class HarborScanError extends Error {
  constructor(
    readonly kind: HarborFailure,
    readonly status: number | null,
    message: string
  ) {
    super(message);
  }
}

const ACCEPT_HEADER = REPORT_MIME_TYPES.join(', ');

const DETECT_TTL_MS = 10 * 60_000;
const DETECT_RETRY_MS = 60_000;

export interface HarborDetection {
  harbor: boolean;
  reason: string | null;
  transient: boolean;
}

export function readSystemInfo(status: number, body: unknown, base: string): HarborDetection {
  const info = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (status >= 200 && status < 300 && info && 'harbor_version' in info) {
    return { harbor: true, reason: null, transient: false };
  }
  if (status >= 500) {
    return { harbor: false, reason: `Harbor at ${base} answered ${status}.`, transient: true };
  }
  return {
    harbor: false,
    reason: `The registry at ${base} isn't Harbor, so it can't scan images. Use the Orchard scanner instead.`,
    transient: false
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@Injectable()
export class HarborScanClient {
  private readonly pullRegistry = process.env.DOCKER_REGISTRY_PULL || '';
  private readonly pushRegistry = process.env.DOCKER_REGISTRY_PUSH || '';
  private readonly project = process.env.REGISTRY_PROJECT || 'orchard';
  private readonly username = process.env.HARBOR_USERNAME || '';
  private readonly password = process.env.HARBOR_PASSWORD || '';
  private readonly apiBase = (
    process.env.HARBOR_API_URL ||
    (this.pullRegistry
      ? /^https?:\/\//i.test(this.pullRegistry)
        ? this.pullRegistry
        : `https://${this.pullRegistry}`
      : '')
  ).replace(/\/+$/, '');
  private readonly timeoutMs = positiveInt(process.env.HARBOR_API_TIMEOUT_MS, 8_000);

  private detection: { at: number; ttl: number; value: Promise<HarborDetection> } | null = null;

  get configured(): boolean {
    return Boolean(this.apiBase && this.username && this.password && this.project);
  }

  detect(): Promise<HarborDetection> {
    if (!this.configured) {
      return Promise.resolve({
        harbor: false,
        reason: "Harbor isn't set up.",
        transient: false
      });
    }
    const cached = this.detection;
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
    const entry = { at: Date.now(), ttl: DETECT_TTL_MS, value: this.probe() };
    void entry.value.then((d) => {
      if (d.transient) entry.ttl = DETECT_RETRY_MS;
    });
    this.detection = entry;
    return entry.value;
  }

  private async probe(): Promise<HarborDetection> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/api/v2.0/systeminfo`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      return {
        harbor: false,
        reason: `No Harbor API answered at ${this.apiBase}: ${(err as Error)?.message || 'request failed'}`,
        transient: true
      };
    }
    const body = await res.json().catch(() => null);
    return readSystemInfo(res.status, body, this.apiBase);
  }

  get registryConfig(): ImageRegistryConfig {
    return { registries: [this.pullRegistry, this.pushRegistry], project: this.project };
  }

  private artifactUrl(ref: HarborImageRef, suffix = ''): string {
    return `${this.apiBase}/api/v2.0/projects/${encodeURIComponent(this.project)}/repositories/${encodeRepository(ref.repository)}/artifacts/${encodeURIComponent(ref.reference)}${suffix}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    try {
      return await fetch(url, {
        ...init,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'X-Accept-Vulnerabilities': ACCEPT_HEADER,
          ...(init.headers ?? {})
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new HarborScanError('unreachable', null, (err as Error)?.message || 'request failed');
    }
  }

  private fail(res: Response, what: string): never {
    if (res.status === 404) throw new HarborScanError('not_found', 404, `${what}: not found`);
    if (res.status === 401 || res.status === 403)
      throw new HarborScanError('unauthorized', res.status, `${what}: ${res.status}`);
    if (res.status === 422 || res.status === 400)
      throw new HarborScanError('not_scannable', res.status, `${what}: ${res.status}`);
    throw new HarborScanError('unreachable', res.status, `${what}: ${res.status}`);
  }

  async artifact(ref: HarborImageRef): Promise<HarborArtifact> {
    const res = await this.request(
      this.artifactUrl(ref, '?with_scan_overview=true&with_tag=false')
    );
    if (!res.ok) this.fail(res, 'artifact');
    return (await res.json()) as HarborArtifact;
  }

  async vulnerabilities(ref: HarborImageRef): Promise<unknown> {
    const res = await this.request(this.artifactUrl(ref, '/additions/vulnerabilities'));
    if (!res.ok) this.fail(res, 'vulnerabilities');
    const text = await res.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HarborScanError('unreachable', res.status, 'vulnerabilities: unreadable body');
    }
  }

  async scan(ref: HarborImageRef): Promise<'started' | 'already_running'> {
    const res = await this.request(this.artifactUrl(ref, '/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_type: 'vulnerability' })
    });
    if (res.status === 202 || res.ok) return 'started';
    if (res.status === 409) return 'already_running';
    this.fail(res, 'scan');
  }
}
