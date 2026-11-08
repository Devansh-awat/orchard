import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { PrismaService } from '../prisma/prisma.service';

export const MCP_CLIENT_CLEANUP_MS = 60 * 60 * 1000;
export const MCP_CLIENT_BATCH = 500;
export const MCP_CLIENT_MAX_BATCHES = 20;
export const MCP_UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_IDLE_CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MCP_CLIENT_TRACKING_SINCE = new Date('2026-12-01T00:00:00Z');

@Injectable()
export class McpClientCleanupService {
  private readonly logger = new Logger(McpClientCleanupService.name);

  private running = false;

  constructor(
    private readonly lease: LeaseService,
    private readonly prisma: PrismaService
  ) {}

  @Interval(MCP_CLIENT_CLEANUP_MS)
  async tick(): Promise<void> {
    if (!this.lease.canCoordinate || !this.lease.isHolder(GLOBAL_LEADER_LEASE) || this.running) {
      return;
    }
    this.running = true;
    try {
      const removed = await this.cleanup();
      if (removed) this.logger.log(`removed ${removed} unused MCP clients`);
    } catch (err) {
      this.logger.warn(`MCP client cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async cleanup(now = Date.now()): Promise<number> {
    const where = {
      OR: [
        {
          lastUsedAt: null,
          createdAt: {
            gte: MCP_CLIENT_TRACKING_SINCE,
            lt: new Date(now - MCP_UNUSED_CLIENT_TTL_MS)
          }
        },
        { lastUsedAt: { lt: new Date(now - MCP_IDLE_CLIENT_TTL_MS) } }
      ]
    };
    let total = 0;
    for (let i = 0; i < MCP_CLIENT_MAX_BATCHES; i++) {
      const stale = await this.prisma.mcpOauthClient.findMany({
        where,
        select: { id: true },
        take: MCP_CLIENT_BATCH
      });
      if (stale.length === 0) break;
      const result = await this.prisma.mcpOauthClient.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } }
      });
      total += result.count;
      if (stale.length < MCP_CLIENT_BATCH) break;
    }
    return total;
  }
}
