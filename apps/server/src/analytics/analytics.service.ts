import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PostHog } from 'posthog-node';

type Primitive = string | number | boolean | null;
export type AnalyticsProps = Record<string, Primitive | Primitive[] | Record<string, unknown>>;

export interface CaptureInput {
  distinctId: string;
  event: string;
  properties?: AnalyticsProps;
  groups?: Record<string, string>;
}

const FLAG_TTL_MS = 60_000;
const FLAG_UNKNOWN_TTL_MS = 5_000;
const COLD_FLAG_RETRY_MS = [250, 750];
const FLAG_CACHE_MAX = 5_000;

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);

  private readonly flagCache = new Map<string, { value: boolean; at: number }>();
  private readonly flagInflight = new Map<string, Promise<boolean>>();

  private readonly client: PostHog | null;

  get configured(): boolean {
    return this.client !== null;
  }

  constructor() {
    const key = process.env.POSTHOG_API_KEY;
    if (!key) {
      this.client = null;
      this.logger.log('POSTHOG_API_KEY not set — analytics disabled');
      return;
    }
    this.client = new PostHog(key, {
      host: process.env.POSTHOG_HOST || 'https://at.leafd.dev',
      flushAt: 20,
      flushInterval: 10_000
    });
  }

  capture({ distinctId, event, properties, groups }: CaptureInput): void {
    if (!this.client) return;
    try {
      this.client.capture({ distinctId, event, properties, groups });
    } catch (err) {
      this.logger.warn(`capture(${event}) failed: ${(err as Error).message}`);
    }
  }

  identify(distinctId: string, properties: AnalyticsProps): void {
    if (!this.client) return;
    try {
      this.client.identify({ distinctId, properties });
    } catch (err) {
      this.logger.warn(`identify failed: ${(err as Error).message}`);
    }
  }

  groupIdentify(groupType: string, groupKey: string, properties: AnalyticsProps): void {
    if (!this.client) return;
    try {
      this.client.groupIdentify({ groupType, groupKey, properties });
    } catch (err) {
      this.logger.warn(`groupIdentify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Forward an unhandled error to PostHog Error Tracking. distinctId may be
   * a user id, an org/project synthetic id, or "anonymous" — anything is
   * better than no attribution when sifting through the dashboard.
   */
  captureException(
    error: unknown,
    distinctId: string,
    properties?: AnalyticsProps,
    groups?: Record<string, string>
  ): void {
    if (!this.client) return;
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      this.client.captureException(err, distinctId, {
        ...(properties ?? {}),
        ...(groups ? { $groups: groups } : {})
      });
    } catch (e) {
      this.logger.warn(`captureException failed: ${(e as Error).message}`);
    }
  }

  /**
   * Server-side feature flag check, cached per user for a minute and refreshed
   * in the background. Returns false when PostHog is disabled, and the last
   * known answer when PostHog fails, so a slow flags call never flips a user off.
   */
  async isFeatureEnabled(
    key: string,
    distinctId: string,
    options?: { groups?: Record<string, string>; personProperties?: Record<string, unknown> }
  ): Promise<boolean> {
    if (!this.client) return false;
    if (options) return (await this.evaluateFlag(key, distinctId, options)) ?? false;
    const id = `${key}\u0000${distinctId}`;
    const cached = this.flagCache.get(id);
    if (cached) {
      if (Date.now() - cached.at >= FLAG_TTL_MS) void this.refreshFlag(id, key, distinctId);
      return cached.value;
    }
    return this.refreshFlag(id, key, distinctId);
  }

  async isEarlyAccessEnabled(
    key: string,
    distinctId: string,
    options?: { groups?: Record<string, string>; personProperties?: Record<string, unknown> }
  ): Promise<boolean> {
    if (!this.client) return true;
    return this.isFeatureEnabled(key, distinctId, options);
  }

  private refreshFlag(id: string, key: string, distinctId: string): Promise<boolean> {
    const running = this.flagInflight.get(id);
    if (running) return running;
    const pending = this.evaluateColdAware(id, key, distinctId).then((value) => {
      this.flagInflight.delete(id);
      const previous = this.flagCache.get(id);
      if (value === null && previous) return previous.value;
      const resolved = value ?? false;
      const at = value === null ? Date.now() - FLAG_TTL_MS + FLAG_UNKNOWN_TTL_MS : Date.now();
      this.flagCache.delete(id);
      this.flagCache.set(id, { value: resolved, at });
      if (this.flagCache.size > FLAG_CACHE_MAX) {
        const oldest = this.flagCache.keys().next().value;
        if (oldest !== undefined) this.flagCache.delete(oldest);
      }
      return resolved;
    });
    this.flagInflight.set(id, pending);
    return pending;
  }

  private async evaluateColdAware(
    id: string,
    key: string,
    distinctId: string
  ): Promise<boolean | null> {
    const first = await this.evaluateFlag(key, distinctId);
    if (first !== null || this.flagCache.has(id)) return first;
    for (const wait of COLD_FLAG_RETRY_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const next = await this.evaluateFlag(key, distinctId);
      if (next !== null) return next;
    }
    return null;
  }

  private async evaluateFlag(
    key: string,
    distinctId: string,
    options?: { groups?: Record<string, string>; personProperties?: Record<string, unknown> }
  ): Promise<boolean | null> {
    try {
      const result = await this.client!.isFeatureEnabled(key, distinctId, options as any);
      return result === undefined ? null : Boolean(result);
    } catch (err) {
      this.logger.warn(`isFeatureEnabled(${key}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Server-side variant lookup for multivariate flags / experiments. Returns
   * undefined when PostHog is disabled, the flag is missing, or on error.
   */
  async getFeatureFlag(
    key: string,
    distinctId: string,
    options?: { groups?: Record<string, string>; personProperties?: Record<string, unknown> }
  ): Promise<string | boolean | undefined> {
    if (!this.client) return undefined;
    try {
      return await this.client.getFeatureFlag(key, distinctId, options as any);
    } catch (err) {
      this.logger.warn(`getFeatureFlag(${key}) failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.shutdown();
    } catch (err) {
      this.logger.warn(`shutdown failed: ${(err as Error).message}`);
    }
  }
}
