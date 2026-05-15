import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import UAParser from 'ua-parser-js';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new session record when a user logs in.
   */
  async createSession(params: {
    userId: string;
    ipAddress?: string;
    userAgent?: string;
    authMethod?: string;
  }): Promise<string> {
    const deviceName = params.userAgent
      ? this.parseDeviceName(params.userAgent)
      : null;

    const location = params.ipAddress
      ? await this.lookupLocation(params.ipAddress)
      : null;

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        deviceName,
        location,
        authMethod: params.authMethod || null,
        expiresAt,
      },
    });

    return session.id;
  }

  /**
   * Validate that a session is still active (not revoked, not expired).
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.expiresAt < new Date()) return false;

    return true;
  }

  /**
   * Update the lastActiveAt timestamp for a session.
   */
  async touchSession(sessionId: string): Promise<void> {
    await this.prisma.session
      .update({
        where: { id: sessionId },
        data: { lastActiveAt: new Date() },
      })
      .catch(() => {});
  }

  /**
   * Get all active sessions for a user.
   */
  async getUserSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        deviceName: true,
        location: true,
        authMethod: true,
        lastActiveAt: true,
        createdAt: true,
      },
    });

    return sessions;
  }

  /**
   * Revoke a specific session.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) return false;

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    return true;
  }

  /**
   * Revoke all sessions for a user except the current one. API tokens are
   * also revoked here — "sign out everywhere" without this leaves long-lived
   * tokens valid and silently undermines the user's expectation that they
   * have logged out of every entry point.
   */
  async revokeAllSessions(
    userId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const where: any = {
      userId,
      revokedAt: null,
    };

    if (exceptSessionId) {
      where.id = { not: exceptSessionId };
    }

    const [sessionRes] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where,
        data: { revokedAt: new Date() },
      }),
      this.prisma.apiToken.deleteMany({ where: { userId } }),
    ]);

    return sessionRes.count;
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
   * Look up approximate location from IP address.
   * Uses a simple heuristic - for private/local IPs returns null.
   * For production, you can integrate with a geolocation service.
   */
  private async lookupLocation(ip: string): Promise<string | null> {
    if (!ip || ip === 'unknown') return null;

    // Skip private/local IPs
    if (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('10.') ||
      ip.startsWith('172.') ||
      ip.startsWith('192.168.') ||
      ip === 'localhost'
    ) {
      return null;
    }

    // Try to get location from a free API (ip-api.com, no key required)
    try {
      const response = await fetch(
        `http://ip-api.com/json/${ip}?fields=city,regionName,country`,
      );
      if (response.ok) {
        const data = await response.json();
        if (data.city && data.country) {
          const parts = [data.city];
          if (data.regionName) parts.push(data.regionName);
          parts.push(data.country);
          return parts.join(', ');
        }
      }
    } catch {
      // Geolocation is best-effort
    }

    return null;
  }
}
