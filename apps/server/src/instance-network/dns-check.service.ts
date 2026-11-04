import { Injectable, Logger } from '@nestjs/common';
import { Resolver } from 'dns/promises';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { WILDCARD, NETWORK } from '../instance-config/instance-config.sections';
import { ExpectedHostname, expectedHostnames } from './hostnames';

export type DnsVerdict = 'ok' | 'missing' | 'different' | 'unknown';

export interface DnsRow extends ExpectedHostname {
  verdict: DnsVerdict;
  addresses: string[];
  expected: string[];
  message: string;
}

export interface DnsReport {
  checkedAt: string;
  /** What the other names are compared against: whatever the dashboard resolves to. */
  reference: string[];
  rows: DnsRow[];
}

const TTL_MS = 30_000;

/**
 * Does DNS actually point here?
 *
 * The reference is the dashboard's own hostname rather than a configured IP.
 * An instance cannot reliably discover its own public address from inside a
 * pod, and it does not need to: every name it serves has to arrive at the same
 * place the dashboard does, whether that is an A record on a routable box or a
 * CNAME into a Cloudflare tunnel. Comparing against the dashboard is the same
 * invariant in every ingress mode.
 */
@Injectable()
export class DnsCheckService {
  private readonly logger = new Logger(DnsCheckService.name);

  private cached: { at: number; value: DnsReport } | null = null;

  constructor(private readonly config: InstanceConfigService) {}

  private appDomain(): string | null {
    return this.config.value(WILDCARD, 'appDomain') || process.env.APP_DOMAIN || null;
  }

  private mcpUrl(): string | null {
    return process.env.MCP_BASE_URL || null;
  }

  hostnames(): ExpectedHostname[] {
    return expectedHostnames({
      frontendUrl: process.env.FRONTEND_URL || null,
      appDomain: this.appDomain(),
      mcpUrl: this.mcpUrl()
    });
  }

  // resolve4 rather than lookup: a pod's resolv.conf carries ndots:5 and a
  // search list, so lookup() tries every search domain first for any name with
  // fewer than five dots. resolve4 asks the question that was actually asked.
  //
  // One try at three seconds, and every name queried at once. This sits behind
  // the setup checklist, which is read on every superadmin page load, so the
  // whole report has to be bounded by one lookup rather than by their sum.
  private async resolve(host: string): Promise<string[]> {
    const resolver = new Resolver({ timeout: 3_000, tries: 1 });
    return resolver.resolve4(host);
  }

  private async addressesFor(host: string): Promise<{ addresses: string[]; error: string | null }> {
    try {
      return { addresses: await this.resolve(host), error: null };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code || 'lookup failed';
      return { addresses: [], error: code };
    }
  }

  async report(force = false): Promise<DnsReport> {
    const now = Date.now();
    if (!force && this.cached && now - this.cached.at < TTL_MS) return this.cached.value;

    const hosts = this.hostnames();
    const looked = await Promise.all(hosts.map((h) => this.addressesFor(h.probe)));
    const reference = looked[hosts.findIndex((h) => h.role === 'platform')]?.addresses ?? [];

    const rows: DnsRow[] = hosts.map((host, i) => {
      const { addresses, error } = looked[i];
      let verdict: DnsVerdict = 'ok';
      let message = 'Resolves here.';

      if (!addresses.length) {
        verdict = 'missing';
        message =
          error === 'ENOTFOUND' || error === 'ENODATA'
            ? 'No record found. Add it at your DNS provider.'
            : `Couldn't resolve it (${error}).`;
        if (host.role === 'apps') {
          message = "No wildcard record found, so generated app URLs won't resolve.";
        }
      } else if (host.role !== 'platform' && !reference.length) {
        verdict = 'unknown';
        message = "Resolves, but the dashboard doesn't, so Orchard can't compare them.";
      } else if (host.role !== 'platform' && !addresses.some((a) => reference.includes(a))) {
        // Advisory, not a failure. A CDN or proxy in front of the zone hands
        // out different anycast addresses per hostname quite legitimately, and
        // calling that broken would put a permanent red badge on instances
        // that are working perfectly well.
        verdict = 'different';
        message =
          'Resolves to a different address than the dashboard. This is normal behind a proxy or CDN. Otherwise, check the record.';
      }

      return {
        ...host,
        verdict,
        addresses,
        expected: host.role === 'platform' ? [] : reference,
        message
      };
    });

    const value: DnsReport = { checkedAt: new Date().toISOString(), reference, rows };
    this.cached = { at: now, value };
    return value;
  }

  /** The instance's own address as DNS sees it, for anything that needs to state one. */
  async dashboardAddresses(): Promise<string[]> {
    return (await this.report()).reference;
  }

  /**
   * Only a missing record counts as unfinished. "Resolves somewhere else" is
   * reported but never badged, because it is the normal state behind a proxy.
   */
  static outstanding(report: DnsReport | null): DnsRow[] {
    return (report?.rows ?? []).filter((r) => r.verdict === 'missing');
  }

  async allResolve(): Promise<boolean> {
    const report = await this.report();
    return report.rows.length > 0 && DnsCheckService.outstanding(report).length === 0;
  }

  configuredPublicIp(): string {
    return this.config.value(NETWORK, 'publicIp') || '';
  }
}
