import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Doors, type DbDoor } from '@orchardlabs/graft-sdk/server';
import type { Pool } from 'pg';
import { PrismaClient } from './generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(Doors.db) db: DbDoor) {
    super({ adapter: new PrismaPg(db.pool() as unknown as Pool) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
