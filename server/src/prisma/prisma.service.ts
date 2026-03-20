import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database connection timed out after 10s')), 10_000),
    );
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

