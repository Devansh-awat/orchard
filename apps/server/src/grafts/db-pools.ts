import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { GraftRecord } from './graft-registry';
import { graftSchema } from './migrations';

@Injectable()
export class GraftDbPools implements OnModuleDestroy {
  private readonly logger = new Logger('Grafts');
  private readonly pools = new Map<string, Pool>();

  poolFor(record: GraftRecord): Pool {
    const existing = this.pools.get(record.id);
    if (existing) return existing;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const max = Number(process.env.ORCHARD_GRAFT_DB_POOL ?? 3) || 3;
    const schema = graftSchema(record.id);
    const pool = new Pool({ connectionString, max, options: `-c search_path=${schema},public` });
    if (record.dbRole) {
      const role = record.dbRole;
      pool.on('connect', (client) => {
        client.query(`SET ROLE "${role}"`).catch((err: Error) => {
          this.logger.error(`${record.id}: SET ROLE ${role} failed: ${err.message}`);
        });
      });
    }
    pool.on('error', (err) =>
      this.logger.error(`${record.id}: database pool error: ${err.message}`)
    );
    this.pools.set(record.id, pool);
    return pool;
  }

  usage(): Record<string, { total: number; idle: number; waiting: number; max: number }> {
    return Object.fromEntries(
      [...this.pools].map(([id, pool]) => [
        id,
        {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: pool.options.max ?? 0
        }
      ])
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}
