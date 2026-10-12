import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type { GraftRecord } from '../graft-registry';
import type { GraftManifest } from '../manifest';
import { graftRole, graftSchema } from '../migrations';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class ContextDoorV1 {
  static readonly meta: DoorMeta = { name: 'context', version: 1, status: 'stable' };
  private readonly graft: GraftRecord;

  constructor(@Inject(INQUIRER) parent: unknown) {
    this.graft = bindGraft(parent, ContextDoorV1.meta);
  }

  get id(): string {
    return this.graft.id;
  }

  get version(): string {
    return this.graft.manifest!.version;
  }

  get manifest(): Readonly<GraftManifest> {
    return this.graft.manifest!;
  }

  get schema(): string {
    return graftSchema(this.graft.id);
  }

  get role(): string {
    return graftRole(this.graft.id);
  }

  get apiBase(): string {
    return `/apiv1/${this.graft.id}`;
  }
}
