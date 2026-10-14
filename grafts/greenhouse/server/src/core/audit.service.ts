import { Inject, Injectable } from '@nestjs/common';
import { Doors, type AuditDoor, type AuditEntry } from '@orchardlabs/graft-sdk/server';

export type AuditLogInput = AuditEntry;

@Injectable()
export class AuditService {
  constructor(@Inject(Doors.audit) private readonly audit: AuditDoor) {}

  async log(entry: AuditLogInput): Promise<void> {
    return this.audit.log(entry);
  }
}
