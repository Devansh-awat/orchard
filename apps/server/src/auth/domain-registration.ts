import { Injectable, Logger } from '@nestjs/common';
import { parse } from 'tldts';
import { guardedFetch } from '../notifications/webhook-guard';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;
const HIT_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CACHE = 10_000;

export type DomainKind = 'registrable' | 'public_suffix' | 'private_suffix' | 'invalid';

/**
 * Where a name sits relative to the public suffix list. Only a registrable
 * domain under an ICANN suffix is something a single party can own outright:
 * a public suffix (co.uk) belongs to nobody, and anything under a private
 * suffix (vercel.app, github.io) belongs to a platform that hands names out.
 */
export function classifyDomain(domain: string): { kind: DomainKind; registrable: string | null } {
  const parsed = parse(domain, { allowPrivateDomains: true });
  if (!parsed.hostname || parsed.isIp || !parsed.publicSuffix) {
    return { kind: 'invalid', registrable: null };
  }
  if (parsed.isPrivate) return { kind: 'private_suffix', registrable: parsed.domain };
  if (!parsed.domain) return { kind: 'public_suffix', registrable: null };
  return { kind: 'registrable', registrable: parsed.domain };
}

export function registrationFromRdap(body: unknown): Date | null {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event?.eventAction !== 'registration' || typeof event.eventDate !== 'string') continue;
    const at = new Date(event.eventDate);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return null;
}

/**
 * When the domain behind an address was last registered, from RDAP.
 *
 * A registration date later than the moment Orchard verified an address on
 * that domain means the domain lapsed and someone re-registered it: whoever
 * holds the mailbox now is not who proved it. `undefined` means "couldn't
 * tell" (no RDAP for the TLD, lookup failed, no registration event) and must
 * never be read as "fine" or "changed".
 */
@Injectable()
export class DomainRegistrationService {
  private readonly logger = new Logger(DomainRegistrationService.name);

  private bootstrap: { at: number; services: Array<[string[], string]> } | null = null;

  private readonly cache = new Map<string, { at: number; value: Date | undefined }>();

  async registeredAt(domain: string): Promise<Date | undefined> {
    const { kind, registrable } = classifyDomain(domain.toLowerCase());
    if (kind !== 'registrable' || !registrable) return undefined;

    const cached = this.cache.get(registrable);
    if (cached && Date.now() - cached.at < (cached.value ? HIT_TTL_MS : MISS_TTL_MS)) {
      return cached.value;
    }

    let value: Date | undefined;
    try {
      value = (await this.lookup(registrable)) ?? undefined;
    } catch (err) {
      this.logger.warn(
        `RDAP lookup for ${registrable} failed: ${err instanceof Error ? err.message : 'error'}`
      );
      value = undefined;
    }
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(registrable, { at: Date.now(), value });
    return value;
  }

  /** True only when RDAP positively says the domain was registered after `since`. */
  async changedHandsSince(domain: string, since: Date | null | undefined): Promise<boolean> {
    if (!since) return false;
    const registered = await this.registeredAt(domain);
    return Boolean(registered && registered.getTime() > since.getTime());
  }

  private async lookup(registrable: string): Promise<Date | null> {
    const base = await this.serverFor(registrable);
    if (!base) return null;
    const url = `${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(registrable)}`;
    const res = await this.fetchJson(url);
    return registrationFromRdap(res);
  }

  private async serverFor(registrable: string): Promise<string | null> {
    if (!this.bootstrap || Date.now() - this.bootstrap.at > BOOTSTRAP_TTL_MS) {
      const body = (await this.fetchJson(BOOTSTRAP_URL)) as { services?: unknown };
      const services = Array.isArray(body?.services)
        ? (body.services as unknown[])
            .filter(
              (s): s is [string[], string[]] =>
                Array.isArray(s) && Array.isArray(s[0]) && Array.isArray(s[1])
            )
            .map(([tlds, urls]): [string[], string] => [
              tlds.map((t) => String(t).toLowerCase()),
              urls.map(String).find((u) => u.startsWith('https://')) ?? ''
            ])
            .filter(([, url]) => url)
        : [];
      this.bootstrap = { at: Date.now(), services };
    }
    const labels = registrable.split('.');
    for (let i = 1; i < labels.length; i += 1) {
      const suffix = labels.slice(i).join('.');
      const hit = this.bootstrap.services.find(([tlds]) => tlds.includes(suffix));
      if (hit) return hit[1];
    }
    return null;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await guardedFetch(url, {
      label: 'RDAP',
      maxBodyBytes: MAX_BODY_BYTES,
      headers: { Accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
