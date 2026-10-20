import { createHash, createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

export type FcEventType = 'accepted' | 'phase' | 'log' | 'result';

export interface FcEvent {
  t: FcEventType;
  at: number;
  phase?: string;
  stream?: string;
  data?: string;
  ok?: boolean;
  error?: string;
  timings?: Record<string, number>;
}

export interface FcStep {
  name: string;
  script: string;
  env?: Record<string, string>;
}

export interface FcBuildRequest {
  id: string;
  deploymentId: string;
  tenant: string;
  repository: string;
  source:
    | { kind: 'git'; cloneUrl: string; branch: string }
    | { kind: 'context'; contextUrl: string };
  steps: FcStep[];
  dockerConfig?: unknown;
  timeoutSeconds?: number;
}

export type FcBuildState = 'running' | 'succeeded' | 'failed' | 'lost';

export interface FcBuildStatus {
  id: string;
  deploymentId: string;
  status: FcBuildState;
  error?: string;
}

export interface FcHost {
  id: string;
  url: string;
}

export interface FcStream {
  host: FcHost;
  events: AsyncGenerator<{ event: FcEvent; offset: number }>;
}

export class FcUnavailableError extends Error {}

export function rendezvousScore(hostId: string, key: string): bigint {
  return createHash('sha256').update(`${hostId}\0${key}`).digest().readBigUInt64BE(0);
}

export function rankHosts<T extends { id: string }>(hosts: T[], key: string): T[] {
  return [...hosts].sort((a, b) => {
    const sa = rendezvousScore(a.id, key);
    const sb = rendezvousScore(b.id, key);
    if (sa === sb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return sa > sb ? -1 : 1;
  });
}

export function parseHosts(raw: string | undefined): FcHost[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((url) => {
      let id = url;
      try {
        id = new URL(url).hostname.split('.')[0] || url;
      } catch {
        id = url;
      }
      return { id, url };
    });
}

export function signFcToken(secret: string, nowSeconds: number, ttlSeconds = 60): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const signing = `${enc({ alg: 'HS256' })}.${enc({ aud: 'fc-builder', iat: nowSeconds, exp: nowSeconds + ttlSeconds })}`;
  return `${signing}.${createHmac('sha256', secret).update(signing).digest('base64url')}`;
}

export async function* ndjson(
  body: ReadableStream<Uint8Array>,
  startOffset = 0
): AsyncGenerator<{ event: FcEvent; offset: number }> {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  let offset = startOffset;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, Buffer.from(value)]);
      for (;;) {
        const nl = pending.indexOf(0x0a);
        if (nl < 0) break;
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        offset += nl + 1;
        if (line.length === 0) continue;
        let event: FcEvent;
        try {
          event = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        yield { event, offset };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

@Injectable()
export class FirecrackerClient {
  private readonly logger = new Logger(FirecrackerClient.name);

  readonly hosts = parseHosts(process.env.FC_BUILDER_HOSTS);

  private readonly secret = (process.env.FC_BUILDER_TOKEN || '').trim();

  get enabled(): boolean {
    return process.env.FC_BUILDER_ENABLED === 'true' && this.hosts.length > 0 && this.secret !== '';
  }

  hostById(id: string | undefined): FcHost | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${signFcToken(this.secret, Math.floor(Date.now() / 1000))}`,
      ...extra
    };
  }

  async start(req: FcBuildRequest, signal?: AbortSignal): Promise<FcStream> {
    const failures: string[] = [];
    for (const host of rankHosts(this.hosts, req.tenant)) {
      let res: Response;
      try {
        res = await fetch(`${host.url}/v1/builds`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(req),
          signal
        });
      } catch (error) {
        failures.push(`${host.id}: ${(error as Error).message}`);
        continue;
      }
      if (res.ok && res.body) {
        return { host, events: ndjson(res.body) };
      }
      const text = await res.text().catch(() => '');
      failures.push(`${host.id}: ${res.status} ${text.slice(0, 200)}`);
      if (res.status === 400 || res.status === 401) break;
    }
    this.logger.warn(`no firecracker host took build ${req.id}: ${failures.join('; ')}`);
    throw new FcUnavailableError(failures.join('; ') || 'no firecracker hosts configured');
  }

  async resume(
    host: FcHost,
    buildId: string,
    offset: number,
    signal?: AbortSignal
  ): Promise<FcStream> {
    const res = await fetch(
      `${host.url}/v1/builds/${encodeURIComponent(buildId)}/events?offset=${offset}`,
      { headers: this.headers(), signal }
    );
    if (!res.ok || !res.body) {
      throw new Error(`resume ${buildId} on ${host.id}: ${res.status}`);
    }
    return { host, events: ndjson(res.body, offset) };
  }

  async status(host: FcHost, buildId: string): Promise<FcBuildStatus | 'not_found'> {
    const res = await fetch(`${host.url}/v1/builds/${encodeURIComponent(buildId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000)
    });
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw new Error(`status ${buildId} on ${host.id}: ${res.status}`);
    return (await res.json()) as FcBuildStatus;
  }

  async cancelDeployment(deploymentId: string): Promise<number> {
    if (!this.enabled) return 0;
    const results = await Promise.allSettled(
      this.hosts.map(async (host) => {
        const res = await fetch(
          `${host.url}/v1/builds?deploymentId=${encodeURIComponent(deploymentId)}`,
          { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(3_000) }
        );
        if (!res.ok) return 0;
        const body = (await res.json()) as { cancelled?: number };
        return body.cancelled ?? 0;
      })
    );
    return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
  }
}
