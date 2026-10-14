import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';
import { SecretCryptoService } from '../core/secret-crypto.service';

export const AGENT_USAGE_TTL_MS = 60_000;
export const AGENT_USAGE_TIMEOUT_MS = 5_000;
export const ANTHROPIC_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const CACHE_LIMIT = 500;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 30 * 60_000;

type JsonResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; retryAfterMs: number | null };

export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface AgentUsageWindow {
  usedPercent: number;
  leftPercent: number;
  resetsAt: string | null;
}

export type AgentUsageUnavailableReason = 'no_token' | 'api_key' | 'unavailable' | 'rate_limited';

export type AgentUsage =
  | {
      available: true;
      provider: string;
      loginMethod: string;
      plan: string | null;
      email: string | null;
      emailMasked: boolean;
      fiveHour: AgentUsageWindow | null;
      sevenDay: AgentUsageWindow | null;
      fetchedAt: string;
    }
  | { available: false; reason: AgentUsageUnavailableReason };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface CacheEntry {
  at: number;
  value: AgentUsage;
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tail = local.length > 2 ? local[local.length - 1] : '';
  return `${local[0]}***${tail}@${domain}`;
}

export function usageWindow(raw: unknown): AgentUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { utilization?: unknown; resets_at?: unknown };
  const used = typeof value.utilization === 'number' ? value.utilization : Number.NaN;
  if (!Number.isFinite(used)) return null;
  const usedPercent = Math.min(100, Math.max(0, used));
  const reset =
    typeof value.resets_at === 'string' && !Number.isNaN(Date.parse(value.resets_at))
      ? new Date(value.resets_at).toISOString()
      : null;
  return { usedPercent, leftPercent: 100 - usedPercent, resetsAt: reset };
}

const PLAN_BY_ORG_TYPE: Record<string, string> = {
  claude_max: 'Max',
  claude_pro: 'Pro',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise'
};

export function profilePlan(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as {
    account?: { has_claude_max?: unknown; has_claude_pro?: unknown };
    organization?: { organization_type?: unknown; rate_limit_tier?: unknown };
  };
  const type = body.organization?.organization_type;
  let plan = typeof type === 'string' ? (PLAN_BY_ORG_TYPE[type] ?? null) : null;
  if (!plan && body.account?.has_claude_max === true) plan = 'Max';
  if (!plan && body.account?.has_claude_pro === true) plan = 'Pro';
  const tier = body.organization?.rate_limit_tier;
  if (plan === 'Max' && typeof tier === 'string') {
    const multiple = /_(\d+)x$/.exec(tier)?.[1];
    if (multiple) plan = `Max ${multiple}x`;
  }
  return plan;
}

export function profileEmail(raw: unknown): string | null {
  const email = (raw as { account?: { email?: unknown } } | null)?.account?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
}

@Injectable()
export class SandboxAgentUsageService {
  private readonly logger = new Logger(SandboxAgentUsageService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AgentUsage>>();
  private readonly lastGood = new Map<string, AgentUsage & { available: true }>();
  private readonly limitedUntil = new Map<string, number>();
  private readonly noProfile = new Set<string>();
  fetcher: Fetcher = (url, init) => fetch(url, init);
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService
  ) {}

  async forSandbox(sandbox: { userId: string }, callerId: string): Promise<AgentUsage> {
    const usage = await this.forHost(sandbox.userId);
    if (!usage.available || !usage.email || callerId === sandbox.userId) return usage;
    return { ...usage, email: maskEmail(usage.email), emailMasked: true };
  }

  private async hostToken(hostId: string): Promise<string | null> {
    const credential = await this.prisma.sandboxCredential.findUnique({
      where: { userId: hostId },
      select: { claudeToken: true }
    });
    if (!credential?.claudeToken) return null;
    try {
      const token = this.crypto.decrypt(credential.claudeToken).replace(/\s+/g, '');
      return token || null;
    } catch {
      return null;
    }
  }

  private async forHost(hostId: string): Promise<AgentUsage> {
    const token = await this.hostToken(hostId);
    if (!token) return { available: false, reason: 'no_token' };
    if (token.startsWith('sk-ant-api')) return { available: false, reason: 'api_key' };
    const key = `${hostId}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < AGENT_USAGE_TTL_MS) return cached.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const work = this.load(key, token)
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private remember(key: string, value: AgentUsage) {
    for (const [k, entry] of this.cache) {
      if (this.now() - entry.at >= AGENT_USAGE_TTL_MS) this.cache.delete(k);
    }
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: this.now(), value });
  }

  private async getJson(url: string, token: string): Promise<JsonResult> {
    try {
      const res = await this.fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(AGENT_USAGE_TIMEOUT_MS)
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        this.logger.debug(`Anthropic OAuth ${new URL(url).pathname} answered ${res.status}`);
        return {
          ok: false,
          status: res.status,
          retryAfterMs: retryAfterMs(res.headers.get('retry-after'), this.now())
        };
      }
      return { ok: true, body: (await res.json()) as unknown };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'error';
      this.logger.debug(`Anthropic OAuth ${new URL(url).pathname} failed: ${name}`);
      return { ok: false, status: 0, retryAfterMs: null };
    }
  }

  private async load(key: string, token: string): Promise<AgentUsage> {
    const known = this.lastGood.get(key) ?? null;
    const limited = this.limitedUntil.get(key) ?? 0;
    if (limited > this.now()) return known ?? { available: false, reason: 'rate_limited' };
    const skipProfile = this.noProfile.has(key);
    const [usageRes, profileRes] = await Promise.all([
      this.getJson(ANTHROPIC_OAUTH_USAGE_URL, token),
      skipProfile
        ? Promise.resolve<JsonResult>({ ok: false, status: 403, retryAfterMs: null })
        : this.getJson(ANTHROPIC_OAUTH_PROFILE_URL, token)
    ]);
    if (!profileRes.ok && profileRes.status === 403) this.noProfile.add(key);
    const throttled = [usageRes, profileRes].find((r) => !r.ok && r.status === 429);
    if (throttled && !throttled.ok) {
      const wait = Math.min(
        throttled.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS,
        MAX_RATE_LIMIT_BACKOFF_MS
      );
      this.limitedUntil.set(key, this.now() + Math.max(wait, AGENT_USAGE_TTL_MS));
    }
    const usage = usageRes.ok ? usageRes.body : null;
    const profile = profileRes.ok ? profileRes.body : null;
    if (!usage && !profile) {
      if (known) return known;
      return {
        available: false,
        reason: !usageRes.ok && usageRes.status === 429 ? 'rate_limited' : 'unavailable'
      };
    }
    if (!usage && known) {
      return {
        ...known,
        plan: profilePlan(profile) ?? known.plan,
        email: profileEmail(profile) ?? known.email
      };
    }
    const windows = (usage ?? {}) as { five_hour?: unknown; seven_day?: unknown };
    const fresh: AgentUsage & { available: true } = {
      available: true,
      provider: 'Anthropic',
      loginMethod: 'Claude account',
      plan: profilePlan(profile),
      email: profileEmail(profile),
      emailMasked: false,
      fiveHour: usageWindow(windows.five_hour),
      sevenDay: usageWindow(windows.seven_day),
      fetchedAt: new Date(this.now()).toISOString()
    };
    if (usage) {
      if (this.lastGood.size >= CACHE_LIMIT && !this.lastGood.has(key)) {
        const oldest = this.lastGood.keys().next().value;
        if (oldest !== undefined) this.lastGood.delete(oldest);
      }
      this.lastGood.set(key, fresh);
      this.limitedUntil.delete(key);
    }
    return fresh;
  }
}
