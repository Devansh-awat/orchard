import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type { Pool } from 'pg';
import { GraftDbPools } from '../db-pools';
import type { GraftRecord } from '../graft-registry';
import { graftSchema } from '../migrations';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class DbDoorV1 {
  static readonly meta: DoorMeta = { name: 'db', version: 1, status: 'stable', capability: 'db' };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(GraftDbPools) private readonly pools: GraftDbPools
  ) {
    this.graft = bindGraft(parent, DbDoorV1.meta);
  }

  get schema(): string {
    return graftSchema(this.graft.id);
  }

  get role(): string | null {
    return this.graft.dbRole ?? null;
  }

  pool(): Pool {
    return this.pools.poolFor(this.graft);
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ) {
    return this.pool().query<T>(text, values);
  }
}
