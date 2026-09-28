import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const clientOptions = {
  omit: { organization: { backupR2AccessKey: true, backupR2SecretKey: true } }
} satisfies Prisma.PrismaClientOptions;

type ClientOptions = typeof clientOptions & { datasourceUrl?: string };

function buildDatasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT ?? '10');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT ?? '20');
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
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
