import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { TUNNEL } from '../instance-config/instance-config.sections';
import { DnsCheckService } from './dns-check.service';
import { ExpectedHostname } from './hostnames';

const API = 'https://api.cloudflare.com/client/v4';

// Where a routed hostname is sent once it is inside the cluster. The tunnel
// terminates at the ingress controller, which owns every host rule already, so
// there is exactly one target however many hostnames are routed.
const INGRESS_SERVICE = 'http://traefik.traefik.svc.cluster.local:80';

export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
}

export interface TunnelRoute extends ExpectedHostname {
  routed: boolean;
  service: string | null;
}

export interface TunnelState {
  configured: boolean;
  /** Present only once credentials work; a token with the wrong scopes reports here. */
  error: string | null;
  tunnelName: string | null;
  canEditDns: boolean;
  routes: TunnelRoute[];
  otherHostnames: string[];
}

@Injectable()
export class CloudflareTunnelService {
  private readonly logger = new Logger(CloudflareTunnelService.name);

  constructor(
    private readonly config: InstanceConfigService,
    private readonly dns: DnsCheckService
  ) {}

  private creds() {
    return {
      apiToken: this.config.value(TUNNEL, 'apiToken') || '',
      accountId: this.config.value(TUNNEL, 'accountId') || '',
      tunnelId: this.config.value(TUNNEL, 'tunnelId') || '',
      zoneId: this.config.value(TUNNEL, 'zoneId') || ''
    };
  }

  isConfigured(): boolean {
    return this.config.isConfigured(TUNNEL);
  }

  /**
   * Cloudflare answers 200 with `success: false` for most application-level
   * failures, so the status code alone never says whether a call worked.
   */
  private async call<T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: init.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (e: any) {
      throw new BadRequestException(`Could not reach Cloudflare: ${e?.message || e}`);
    }

    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok || !payload?.success) {
      const detail = payload?.errors
        ?.map((e: any) => e.message)
        .filter(Boolean)
        .join('; ');
      throw new BadRequestException(
        detail || `Cloudflare rejected the request (HTTP ${response.status})`
      );
    }
    return payload.result as T;
  }

  private async ingressRules(token: string, accountId: string, tunnelId: string) {
    const result = await this.call<{ config?: { ingress?: IngressRule[] } }>(
      token,
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`
    );
    return result?.config?.ingress ?? [];
  }

  async state(): Promise<TunnelState> {
    const hostnames = this.dns.hostnames();
    const empty: TunnelState = {
      configured: false,
      error: null,
      tunnelName: null,
      canEditDns: false,
      routes: hostnames.map((h) => ({ ...h, routed: false, service: null })),
      otherHostnames: []
    };

    if (!this.isConfigured()) return empty;

    const { apiToken, accountId, tunnelId, zoneId } = this.creds();
    try {
      const tunnel = await this.call<{ name?: string }>(
        apiToken,
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}`
      );
      const rules = await this.ingressRules(apiToken, accountId, tunnelId);
      const byHost = new Map(rules.filter((r) => r.hostname).map((r) => [r.hostname as string, r]));

      return {
        configured: true,
        error: null,
        tunnelName: tunnel?.name ?? null,
        canEditDns: Boolean(zoneId),
        routes: hostnames.map((h) => {
          // A wildcard is routed as the wildcard, not as the probe label.
          const match = byHost.get(h.record) || byHost.get(h.probe);
          return { ...h, routed: Boolean(match), service: match?.service ?? null };
        }),
        otherHostnames: rules
          .map((r) => r.hostname)
          .filter((h): h is string => Boolean(h))
          .filter((h) => !hostnames.some((e) => e.record === h || e.probe === h))
      };
    } catch (e: any) {
      return { ...empty, configured: true, error: e?.message || 'Cloudflare request failed' };
    }
  }

  /**
   * Add one hostname to the tunnel, and the DNS record that sends it there.
   *
   * Both halves are needed and people routinely do only one: an ingress rule
   * with no CNAME is a route nothing reaches, and a CNAME with no ingress rule
   * is Cloudflare returning its own 1033 error page.
   */
  async route(record: string): Promise<TunnelState> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Cloudflare credentials are not configured');
    }
    const known = this.dns.hostnames().find((h) => h.record === record);
    if (!known) {
      throw new BadRequestException('That hostname is not one this instance serves');
    }

    const { apiToken, accountId, tunnelId, zoneId } = this.creds();
    const rules = await this.ingressRules(apiToken, accountId, tunnelId);

    // The catch-all has no hostname and has to stay last, so new rules go in
    // ahead of it rather than on the end.
    const specific = rules.filter((r) => r.hostname);
    const fallback = rules.filter((r) => !r.hostname);
    if (!specific.some((r) => r.hostname === record)) {
      specific.push({ hostname: record, service: INGRESS_SERVICE });
    }
    const ingress = [
      ...specific,
      ...(fallback.length ? fallback : [{ service: 'http_status:404' }])
    ];

    await this.call(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: 'PUT',
      body: { config: { ingress } }
    });

    if (zoneId) await this.ensureDnsRecord(apiToken, zoneId, tunnelId, record);

    return this.state();
  }

  private async ensureDnsRecord(
    token: string,
    zoneId: string,
    tunnelId: string,
    record: string
  ): Promise<void> {
    const content = `${tunnelId}.cfargotunnel.com`;
    const existing = await this.call<{ id: string; type: string; content: string }[]>(
      token,
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(record)}`
    );

    const match = existing.find((r) => r.type === 'CNAME' && r.content === content);
    if (match) return;

    const stale = existing[0];
    const body = { type: 'CNAME', name: record, content, proxied: true };

    if (stale) {
      await this.call(token, `/zones/${zoneId}/dns_records/${stale.id}`, {
        method: 'PUT',
        body
      });
      return;
    }
    await this.call(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
  }
}
