import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable, filter, map } from 'rxjs';

export type OrgEventType =
  | 'deployment.changed'
  | 'database.changed'
  | 'build.changed'
  | 'project.changed'
  | 'pod.changed'
  | 'membership.changed';

export interface OrgEvent {
  organizationId: string;
  type: OrgEventType;
  /** Optional id of the changed resource (deployment id, db id, etc) */
  id?: string;
  /** Optional secondary id (e.g. projectId for a deployment) */
  projectId?: string;
  /** Best-effort timestamp */
  ts: number;
}

@Injectable()
export class OrgEventsService {
  private readonly logger = new Logger(OrgEventsService.name);
  private readonly subject = new Subject<OrgEvent>();
  /** subscriber counts per orgId; lets background pushers (e.g. metrics) skip orgs nobody is watching. */
  private readonly subscriberCounts = new Map<string, number>();

  emit(ev: Omit<OrgEvent, 'ts'>) {
    this.subject.next({ ...ev, ts: Date.now() });
  }

  /** Returns an observable filtered to events for a given org. */
  forOrg(organizationId: string): Observable<OrgEvent> {
    return this.subject.asObservable().pipe(filter((e) => e.organizationId === organizationId));
  }

  /** SSE-friendly: maps to MessageEvent shape. */
  forOrgAsSse(organizationId: string): Observable<{ data: OrgEvent }> {
    return this.forOrg(organizationId).pipe(map((data) => ({ data })));
  }

  addSubscriber(organizationId: string) {
    this.subscriberCounts.set(
      organizationId,
      (this.subscriberCounts.get(organizationId) ?? 0) + 1,
    );
  }

  removeSubscriber(organizationId: string) {
    const next = (this.subscriberCounts.get(organizationId) ?? 0) - 1;
    if (next <= 0) this.subscriberCounts.delete(organizationId);
    else this.subscriberCounts.set(organizationId, next);
  }

  /** Snapshot of orgIds that currently have at least one SSE subscriber. */
  watchedOrgIds(): string[] {
    return Array.from(this.subscriberCounts.keys());
  }
}
