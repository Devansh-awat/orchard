import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type { Observable } from 'rxjs';
import {
  OrgEventsService,
  type OrgEvent,
  type OrgEventType
} from '../../events/org-events.service';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class EventsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'events',
    version: 1,
    status: 'stable',
    capability: 'events'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(OrgEventsService) private readonly events: OrgEventsService
  ) {
    this.graft = bindGraft(parent, EventsDoorV1.meta);
  }

  emitOrg(
    organizationId: string,
    type: string,
    data: { id?: string; projectId?: string; payload?: unknown } = {}
  ): void {
    assertClaimed(this.graft, 'sseEvents', type, 'event type');
    this.events.emit({ organizationId, type: type as OrgEventType, ...data });
  }

  stream(): Observable<OrgEvent> {
    return this.events.all();
  }
}
