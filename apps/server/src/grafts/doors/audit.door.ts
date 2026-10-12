import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { AuditService, type AuditLogInput } from '../../audit/audit.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class AuditDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'audit',
    version: 1,
    status: 'stable',
    capability: 'audit'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(AuditService) private readonly audit: AuditService
  ) {
    this.graft = bindGraft(parent, AuditDoorV1.meta);
  }

  log(input: AuditLogInput): Promise<void> {
    assertClaimed(this.graft, 'auditActions', input.action, 'audit action');
    return this.audit.log({
      ...input,
      metadata: { ...(input.metadata ?? {}), graft: this.graft.id }
    });
  }
}
