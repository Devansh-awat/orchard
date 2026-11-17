import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const clientOptions = {
  omit: { organization: { backupR2AccessKey: true, backupR2SecretKey: true } }
} satisfies Prisma.PrismaClientOptions;

type ClientOptions = typeof clientOptions & { datasourceUrl?: string };

export function buildDatasourceUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const url = new URL(base);
    const pooler = env.DATABASE_POOLER_HOST?.trim();
    if (pooler) {
      url.hostname = pooler;
      url.port = env.DATABASE_POOLER_PORT?.trim() || '5432';
      url.searchParams.set('pgbouncer', 'true');
    }
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', env.DATABASE_CONNECTION_LIMIT ?? '10');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', env.DATABASE_POOL_TIMEOUT ?? '20');
    }
    return url.toString();
  } catch {
    return base;
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient<ClientOptions>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ ...clientOptions, datasourceUrl: buildDatasourceUrl() });
  }

  async onModuleInit() {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Database connection timed out after 10s')), 10_000);
    });
    try {
      await Promise.race([this.$connect(), timeout]);
      this.logger.log('$connect() done, testing actual query...');
      await Promise.race([this.$queryRaw`SELECT 1`, timeout]);
      this.logger.log('Database connected and query works');
    } catch (error) {
      this.logger.error(`Failed to connect to database: ${error.message}`);
      throw error;
    }
    await this.grantBackupProxyReads();
  }

  private async grantBackupProxyReads() {
    try {
      await this.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orchard_r2_proxy') THEN
            GRANT USAGE ON SCHEMA public TO orchard_r2_proxy;
            GRANT SELECT ON TABLE databases, projects, organizations TO orchard_r2_proxy;
            GRANT SELECT (access_key, secret, write_prefix, read_prefixes, expires_at, purpose)
              ON TABLE storage_access_keys TO orchard_r2_proxy;
          END IF;
        END
        $$
      `);
    } catch (error) {
      this.logger.warn(`couldn't grant the backup proxy its reads: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
