import { ConflictException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostHog } from 'posthog-node';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { EMAIL, STORAGE } from '../instance-config/instance-config.sections';
import { GithubAppConfigService } from '../github/github-app-config.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { TelemetryProps, scrubException } from './telemetry-payload';

export const TELEMETRY_CONSENT_KEY = 'telemetry_consent';
export const TELEMETRY_INSTANCE_ID_KEY = 'telemetry_instance_id';
export const TELEMETRY_LAST_SENT_KEY = 'telemetry_last_sent';
const TELEMETRY_ENV = 'ORCHARD_TELEMETRY';

export const TELEMETRY_HOST = 'https://us.i.posthog.com';
const TELEMETRY_KEY = 'phc_xiowCAioeXBqQJJJkZPpLYDL3SLojssyWKzetRLGeZsZ';

const HEARTBEAT_EVERY_MS = 23 * 60 * 60 * 1000;
const EXCEPTIONS_PER_HOUR = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));

export type TelemetryConsent = 'granted' | 'denied' | null;

export interface TelemetryState {
  enabled: boolean;
  consent: TelemetryConsent;
  envOverride: boolean | null;
  needsAnswer: boolean;
  destination: string;
}

export interface ExceptionContext {
  method?: string;
  route?: string;
  status?: number;
  contextType?: string;
}

@Injectable()
export class TelemetryService implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);

  private client: PostHog | null = null;

  private enabledCache: { value: boolean; at: number } | null = null;

  private exceptionWindow = { start: 0, count: 0 };

  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
    private readonly config: InstanceConfigService,
    private readonly githubApp: GithubAppConfigService,
    private readonly leader: LeaderElectionService
  ) {}

  private envOverride(): boolean | null {
    const v = process.env[TELEMETRY_ENV];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  private async consent(): Promise<TelemetryConsent> {
    const raw = await this.settings.get(TELEMETRY_CONSENT_KEY);
    return raw === 'granted' || raw === 'denied' ? raw : null;
  }

  async getState(): Promise<TelemetryState> {
    const envOverride = this.envOverride();
    const consent = await this.consent();
    return {
      enabled: envOverride ?? consent === 'granted',
      consent,
      envOverride,
      needsAnswer: envOverride === null && consent === null,
      destination: TELEMETRY_HOST
    };
  }

  async setConsent(granted: boolean): Promise<TelemetryState> {
    if (this.envOverride() !== null) {
      throw new ConflictException(
        `This is pinned by the ${TELEMETRY_ENV} environment variable. Unset it to change this here.`
      );
    }
    await this.settings.set(TELEMETRY_CONSENT_KEY, granted ? 'granted' : 'denied');
    this.enabledCache = null;
    if (granted) {
      void this.heartbeat();
    } else {
      await this.settings.delete(TELEMETRY_LAST_SENT_KEY);
      await this.closeClient();
    }
    return this.getState();
  }

  private async isEnabled(): Promise<boolean> {
    const cached = this.enabledCache;
    if (cached && cached.at > Date.now() - 60_000) return cached.value;
    const value = (await this.getState()).enabled;
    this.enabledCache = { value, at: Date.now() };
    return value;
  }

  private canSend(): boolean {
    return !!TELEMETRY_KEY && process.env.NODE_ENV === 'production';
  }

  private posthog(): PostHog {
    if (!this.client) {
      this.client = new PostHog(TELEMETRY_KEY, {
        host: TELEMETRY_HOST,
        disableGeoip: true,
        flushAt: 20,
        flushInterval: 30_000
      });
    }
    return this.client;
  }

  private async instanceId(): Promise<string> {
    await this.settings.createIfAbsent(TELEMETRY_INSTANCE_ID_KEY, randomUUID());
    return (await this.settings.get(TELEMETRY_INSTANCE_ID_KEY)) as string;
  }

  async preview(): Promise<{ event: string; distinctId: string; properties: TelemetryProps }> {
    return {
      event: 'instance_heartbeat',
      distinctId: await this.instanceId(),
      properties: await this.collect()
    };
  }

  private async activeUsers(since: Date): Promise<number> {
    const rows = await this.prisma.session.groupBy({
      by: ['userId'],
      where: { lastActiveAt: { gte: since } }
    });
    return rows.length;
  }

  private async collect(): Promise<TelemetryProps> {
    const now = Date.now();
    const dayAgo = new Date(now - DAY_MS);
    const [
      users,
      active1d,
      active7d,
      active30d,
      organizations,
      projects,
      deployments,
      deploymentsRunning,
      databases,
      jobs,
      sandboxes,
      nodes,
      buildsSucceeded,
      buildsFailed,
      identityProviders,
      mcp,
      userspaceScheduling
    ] = await Promise.all([
      this.prisma.user.count(),
      this.activeUsers(dayAgo),
      this.activeUsers(new Date(now - 7 * DAY_MS)),
      this.activeUsers(new Date(now - 30 * DAY_MS)),
      this.prisma.organization.count(),
      this.prisma.project.count(),
      this.prisma.deployment.count(),
      this.prisma.deployment.count({ where: { stopped: false } }),
      this.prisma.database.count(),
      this.prisma.job.count(),
      this.prisma.sandbox.count(),
      this.prisma.node.count(),
      this.prisma.buildRun.count({ where: { status: 'succeeded', finishedAt: { gte: dayAgo } } }),
      this.prisma.buildRun.count({ where: { status: 'failed', finishedAt: { gte: dayAgo } } }),
      this.prisma.identityProvider.count({ where: { enabled: true } }),
      this.settings.isMcpEnabled(),
      this.settings.isUserspaceSchedulingEnabled()
    ]);

    return {
      version,
      node_version: process.version,
      arch: process.arch,
      users_total: users,
      users_active_1d: active1d,
      users_active_7d: active7d,
      users_active_30d: active30d,
      organizations,
      projects,
      deployments,
      deployments_running: deploymentsRunning,
      databases,
      jobs,
      sandboxes,
      nodes,
      builds_succeeded_24h: buildsSucceeded,
      builds_failed_24h: buildsFailed,
      feature_github_app: this.githubApp.isConfigured(),
      feature_email: this.config.isConfigured(EMAIL),
      feature_backups: this.config.isConfigured(STORAGE),
      feature_sso: identityProviders > 0,
      feature_mcp: mcp,
      feature_userspace_scheduling: userspaceScheduling
    };
  }

  @Interval(60 * 60 * 1000)
  async tick(): Promise<void> {
    if (!this.leader.isLeader()) return;
    await this.heartbeat();
  }

  private async heartbeat(): Promise<void> {
    if (this.sending || !this.canSend()) return;
    this.sending = true;
    try {
      if (!(await this.isEnabled())) return;
      const last = Date.parse((await this.settings.get(TELEMETRY_LAST_SENT_KEY)) ?? '');
      if (Number.isFinite(last) && last > Date.now() - HEARTBEAT_EVERY_MS) return;
      const { event, distinctId, properties } = await this.preview();
      await this.posthog().captureImmediate({
        distinctId,
        event,
        properties: { ...properties, $process_person_profile: false },
        disableGeoip: true
      });
      await this.settings.set(TELEMETRY_LAST_SENT_KEY, new Date().toISOString());
    } catch (e) {
      this.logger.warn(`telemetry heartbeat failed: ${(e as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  private withinExceptionBudget(): boolean {
    const now = Date.now();
    if (now - this.exceptionWindow.start > 60 * 60 * 1000) {
      this.exceptionWindow = { start: now, count: 0 };
    }
    this.exceptionWindow.count += 1;
    return this.exceptionWindow.count <= EXCEPTIONS_PER_HOUR;
  }

  captureException(error: unknown, context: ExceptionContext = {}): void {
    if (!this.canSend()) return;
    void (async () => {
      try {
        if (!(await this.isEnabled()) || !this.withinExceptionBudget()) return;
        const scrubbed = scrubException(error);
        this.posthog().capture({
          distinctId: await this.instanceId(),
          event: '$exception',
          disableGeoip: true,
          properties: {
            $process_person_profile: false,
            $exception_level: 'error',
            $exception_list: [
              {
                type: scrubbed.type,
                value: scrubbed.type,
                mechanism: { handled: false, synthetic: false, type: 'generic' },
                stacktrace: { type: 'raw', frames: scrubbed.frames }
              }
            ],
            version,
            error_code: scrubbed.code,
            http_method: context.method ?? null,
            http_route: context.route ?? null,
            http_status: context.status ?? null,
            context_type: context.contextType ?? null
          }
        });
      } catch (e) {
        this.logger.warn(`telemetry exception forward failed: ${(e as Error).message}`);
      }
    })();
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.shutdown();
    } catch (e) {
      this.logger.warn(`telemetry shutdown failed: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeClient();
  }
}
