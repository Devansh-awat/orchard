import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UAParser } from 'ua-parser-js';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { deviceLabel } from './org-scoped-devices';

// M-1: Geo enrichment uses ipwho.is over HTTPS with a short timeout. Plain HTTP
// would leak every login IP in cleartext and let a network attacker forge the
// "location" stored against the session, enabling social-engineering vectors
// via the "Active sessions" UI. The leak-to-third-party tradeoff is accepted as
// the price of avoiding a local DB.

const GEO_LOOKUP_TIMEOUT_MS = 1500;

export const MCP_SESSION_AUTH_METHOD = 'mcp';

export const MCP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const BROWSER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef
  ) {}

  // NotificationsModule already imports AuthModule, so injecting the service
  // here would close a provider cycle that swc turns into a TDZ crash at boot.
  // Resolved on first use instead, which is after every module is up.
  private notifications(): NotificationsService | null {
    try {
      return this.moduleRef.get(NotificationsService, { strict: false });
    } catch {
      return null;
    }
  }

  async createSession(params: {
    userId: string;
    ipAddress?: string;
    userAgent?: string;
    authMethod?: string;
    deviceName?: string;
    ttlMs?: number;
  }): Promise<string> {
    const deviceName =
      params.deviceName ?? (params.userAgent ? this.parseDeviceName(params.userAgent) : null);

    const location = params.ipAddress ? await this.lookupLocation(params.ipAddress) : null;

    const expiresAt = new Date(Date.now() + (params.ttlMs ?? BROWSER_SESSION_TTL_MS));

    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        deviceName,
        location,
        authMethod: params.authMethod || null,
        expiresAt
      }
    });

    void this.audit.log({
      action: 'user.signed_in',
      actorUserId: params.userId,
      targetType: 'session',
      targetId: session.id,
      metadata: {
        auth_method: params.authMethod ?? null,
        device_name: deviceName ?? null,
        location: location ?? null
      }
    });

    void this.notifySignIn({
      userId: params.userId,
      sessionId: session.id,
      authMethod: params.authMethod ?? null,
      deviceName: deviceLabel(deviceName),
      location,
      ipAddress: params.ipAddress ?? null
    });

    return session.id;
  }

  /**
   * Tell the account holder that something got in. Every way into Orchard ends
   * up here, so this is the one place that has to know about it, and an MCP
   * session is not a person signing in, it is an app being handed the keys, so
   * it reads as its own thing.
   *
   * Never allowed to fail a sign-in. Someone locked out because Slack is down
   * is a worse outcome than a missed alert.
   */
  private async notifySignIn(input: {
    userId: string;
    sessionId: string;
    authMethod: string | null;
    deviceName: string | null;
    location: string | null;
    ipAddress: string | null;
  }): Promise<void> {
    try {
      const notifications = this.notifications();
      if (!notifications) return;

      const app = input.authMethod === MCP_SESSION_AUTH_METHOD;

      // The body says what to do; the fields carry the forensics. Keeping them
      // apart is what stops the device name being read out twice in an app
      // alert that already names it in the subject line.
      const fields = [
        input.deviceName ? { name: app ? 'App' : 'Device', value: input.deviceName } : null,
        input.location ? { name: 'Location', value: input.location } : null,
        input.ipAddress ? { name: 'IP address', value: input.ipAddress } : null,
        input.authMethod ? { name: 'Method', value: input.authMethod } : null
      ].filter((f): f is { name: string; value: string } => f !== null);

      await notifications.notifySecurity(input.userId, {
        event: app ? 'security.app_authorized' : 'security.signed_in',
        title: app
          ? `${input.deviceName || 'An app'} was given access to your account`
          : 'New sign-in to your Orchard account',
        body: app
          ? "It can act as you until you revoke it. If this wasn't you, revoke it and sign out everywhere."
          : "If this wasn't you, sign out everywhere and change how you sign in.",
        url: `${this.frontendUrl}/user/settings?tab=security`,
        targetId: input.sessionId,
        targetName: input.deviceName ?? undefined,
        fields
      });
    } catch (e: any) {
      this.logger.warn(`sign-in notification failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Validate that a session is still active (not revoked, not expired).
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });

    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.expiresAt < new Date()) return false;

    return true;
  }

  private readonly touchedAt = new Map<string, number>();

  async touchSession(sessionId: string): Promise<void> {
    const now = Date.now();
    const last = this.touchedAt.get(sessionId);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    if (this.touchedAt.size > 20_000) this.touchedAt.clear();
    this.touchedAt.set(sessionId, now);
    await this.prisma.session
      .update({
        where: { id: sessionId },
        data: { lastActiveAt: new Date() }
      })
      .catch(() => {});
  }

  /**
   * Sliding expiration for sessions kept alive by an active credential
   * (currently the MCP refresh-token grant). Only live sessions are
   * extended: revoked or already-expired sessions stay dead, so
   * "sign out everywhere" still wins.
   */
  async extendSession(sessionId: string, ttlMs = BROWSER_SESSION_TTL_MS): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: {
        expiresAt: new Date(Date.now() + ttlMs),
        lastActiveAt: new Date()
      }
    });
  }

  async getUserSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        deviceName: true,
        location: true,
        authMethod: true,
        lastActiveAt: true,
        createdAt: true
      }
    });

    return sessions.map((s) => ({ ...s, deviceName: deviceLabel(s.deviceName) }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId }
    });

    if (!session) return false;

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() }
    });

    return true;
  }

  /**
   * Revoke all sessions for a user except the current one. API tokens are
   * also revoked here: "sign out everywhere" without this leaves long-lived
   * tokens valid and silently undermines the user's expectation that they
   * have logged out of every entry point.
   *
   * L-3: this is intentionally unconditional. Do NOT call this helper from
   * scoped flows (org/project removal) where only some tokens should die,
   * use revokeUserSessions plus a targeted apiToken cleanup at the call site.
   * The only legitimate callers are user-initiated "Sign out everywhere"
   * and account-deletion paths, where nuking every token is the goal.
   */
  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const where: any = {
      userId,
      revokedAt: null
    };

    if (exceptSessionId) {
      where.id = { not: exceptSessionId };
    }

    const [sessionRes] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where,
        data: { revokedAt: new Date() }
      }),
      this.prisma.apiToken.deleteMany({ where: { userId } })
    ]);

    return sessionRes.count;
  }

  // Revokes browser and MCP sessions, leaving API tokens intact. Used when a
  // user is removed from one org/project but may still hold tokens scoped to
  // other resources they still belong to: full revocation would nuke
  // unrelated work. Project-scoped tokens for the affected resource are pruned
  // at the call site. Use revokeAllSessions for "sign out everywhere".
  async revokeUserSessions(userId: string): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return res.count;
  }

  async revokeSignInSessions(params: {
    authMethods: string[];
    userIds?: string[];
    exceptSessionId?: string;
  }): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: {
        revokedAt: null,
        authMethod: { in: params.authMethods },
        ...(params.userIds ? { userId: { in: params.userIds } } : {}),
        ...(params.exceptSessionId ? { id: { not: params.exceptSessionId } } : {}),
        user: { isSuperAdmin: false }
      },
      data: { revokedAt: new Date() }
    });
    return res.count;
  }

  async refreshGeneration(sessionId: string): Promise<number | null> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { refreshGeneration: true }
    });
    return session?.refreshGeneration ?? null;
  }

  async rotateRefreshGeneration(sessionId: string, expected: number): Promise<number | null> {
    const res = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        refreshGeneration: expected,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: { refreshGeneration: { increment: 1 } }
    });
    return res.count === 1 ? expected + 1 : null;
  }

  /**
   * Parse User-Agent into a friendly device name.
   */
  private parseDeviceName(userAgent: string): string {
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser();
    const os = parser.getOS();
    const device = parser.getDevice();

    const parts: string[] = [];

    if (device.vendor && device.model) {
      parts.push(`${device.vendor} ${device.model}`);
    }

    if (browser.name) {
      parts.push(browser.name);
    }

    if (os.name) {
      const osStr = os.version ? `${os.name} ${os.version}` : os.name;
      parts.push(osStr);
    }

    return parts.length > 0 ? parts.join(' · ') : 'Unknown Device';
  }

  /**
   * Look up approximate location from IP via ipwho.is over HTTPS. Returns
   * null for private/local IPs, on timeout, or on any error: geolocation
   * is best-effort and must never block auth.
   */
  private async lookupLocation(ip: string): Promise<string | null> {
    if (!ip || ip === 'unknown' || this.isPrivateIp(ip)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEO_LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`,
        { signal: controller.signal }
      );
      if (!response.ok) return null;
      const data = (await response.json()) as {
        success?: boolean;
        city?: string;
        region?: string;
        country?: string;
      };
      if (data.success === false) return null;
      const parts = [data.city, data.region, data.country].filter(
        (s): s is string => typeof s === 'string' && s.length > 0
      );
      return parts.length > 0 ? parts.join(', ') : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private isPrivateIp(ip: string): boolean {
    if (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === 'localhost' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe80:')
    ) {
      return true;
    }
    // 172.16.0.0 – 172.31.255.255
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1] ?? '', 10);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  }
}
