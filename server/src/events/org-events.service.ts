import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable, filter, map } from 'rxjs';
import { AuthorizationService } from '../auth/authorization.service';

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

  constructor(private readonly authz: AuthorizationService) {}

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

  /**
   * Per-user SSE stream: filters events by the user's visible project set so
   * plain org members don't see events for projects they aren't a member of.
   * Spec rule (H3): plain Members MUST NOT see events for non-member projects.
   *
   * `visibleProjectIds` is captured at subscribe-time:
   *   - null  => org-admin/owner/superadmin: see everything
   *   - array => plain member: only events whose projectId is in the set
   */
  forOrgAsSseScoped(
    organizationId: string,
    userId: string,
    visibleProjectIds: string[] | null,
  ): Observable<{ data: OrgEvent }> {
    const allowed = visibleProjectIds === null ? null : new Set(visibleProjectIds);
    return this.forOrg(organizationId).pipe(
      // H3: drop events the user isn't authorized to see (project not in their visible set,
      // or membership.changed referencing another user — plain members shouldn't see it).
      filter((e) => {
        if (allowed === null) return true;
        if (e.type === 'membership.changed') {
          // Plain members: only let through events about themselves.
          return e.id === userId;
        }
        if (!e.projectId) {
          // Org-level event without project scope — drop for plain members.
          return false;
        }
        return allowed.has(e.projectId);
      }),
      map((data) => ({ data })),
    );
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
