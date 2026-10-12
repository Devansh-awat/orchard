import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Subject, Observable, filter, map, takeWhile } from 'rxjs';
import { AuthorizationService } from '../auth/authorization.service';
import { EventBusService } from './event-bus.service';

export type OrgEventType =
  | 'deployment.changed'
  | 'database.changed'
  | 'build.changed'
  | 'project.changed'
  | 'pod.changed'
  | 'membership.changed'
  | 'deployment.metrics'
  | 'job.changed'
  | 'jobrun.changed'
  | 'environment.changed'
  | 'sharedvars.changed'
  | 'engine.changed'
  | 'audit.created';

export interface OrgEvent {
  organizationId: string;
  type: OrgEventType;
  id?: string;
  projectId?: string;
  payload?: unknown;
  ts: number;
}

interface Delivery {
  event: OrgEvent;
  streamId?: string;
}

export interface ScopedMessage {
  data: OrgEvent;
  id?: string;
}

@Injectable()
export class OrgEventsService implements OnModuleInit {
  private readonly logger = new Logger(OrgEventsService.name);

  private readonly subject = new Subject<Delivery>();

  private readonly subscriberCounts = new Map<string, number>();

  constructor(
    private readonly authz: AuthorizationService,
    private readonly bus: EventBusService
  ) {}

  onModuleInit() {
    this.bus.setConsumer((entry) => {
      this.subject.next({ event: entry.event, streamId: entry.id });
    });
  }

  emit(ev: Omit<OrgEvent, 'ts'>) {
    const event: OrgEvent = { ...ev, ts: Date.now() };
    if (this.bus.enabled) {
      this.bus.publish(event).catch(() => {});
    } else {
      this.subject.next({ event });
    }
  }

  all(): Observable<OrgEvent> {
    return this.subject.asObservable().pipe(map((d) => d.event));
  }

  emitLocal(ev: Omit<OrgEvent, 'ts'>) {
    this.subject.next({ event: { ...ev, ts: Date.now() } });
  }

  private visibleTo(event: OrgEvent, userId: string, allowed: Set<string> | null): boolean {
    if (allowed === null) return true;
    if (event.type === 'membership.changed') return event.id === userId;
    if (!event.projectId) return false;
    return allowed.has(event.projectId);
  }

  /**
   * Raw per-deployment event tap for internal streams (build-log tail).
   * Callers must have authorized access to the deployment themselves; no
   * project scoping is applied here.
   */
  forDeployment(type: OrgEventType, deploymentId: string): Observable<OrgEvent> {
    return this.subject.asObservable().pipe(
      filter((d) => d.event.type === type && d.event.id === deploymentId),
      map((d) => d.event)
    );
  }

  forOrgAsSseScoped(
    organizationId: string,
    userId: string,
    visibleProjectIds: string[] | null
  ): Observable<ScopedMessage> {
    const allowed = visibleProjectIds === null ? null : new Set(visibleProjectIds);
    let alive = true;
    return this.subject.asObservable().pipe(
      filter((d) => d.event.organizationId === organizationId),
      takeWhile(() => alive, true),
      filter((d) => {
        if (d.event.type === 'membership.changed' && d.event.id === userId) {
          alive = false;
          return true;
        }
        return this.visibleTo(d.event, userId, allowed);
      }),
      map((d) => ({ data: d.event, id: d.streamId }))
    );
  }

  async replayScoped(
    fromId: string,
    organizationId: string,
    userId: string,
    visibleProjectIds: string[] | null
  ): Promise<ScopedMessage[]> {
    const entries = await this.bus.replay(fromId);
    if (entries.length === 0) return [];
    const allowed = visibleProjectIds === null ? null : new Set(visibleProjectIds);
    const out: ScopedMessage[] = [];
    for (const entry of entries) {
      if (entry.event.organizationId !== organizationId) continue;
      if (!this.visibleTo(entry.event, userId, allowed)) continue;
      out.push({ data: entry.event, id: entry.id });
    }
    return out;
  }

  addSubscriber(organizationId: string) {
    this.subscriberCounts.set(organizationId, (this.subscriberCounts.get(organizationId) ?? 0) + 1);
  }

  removeSubscriber(organizationId: string) {
    const next = (this.subscriberCounts.get(organizationId) ?? 0) - 1;
    if (next <= 0) this.subscriberCounts.delete(organizationId);
    else this.subscriberCounts.set(organizationId, next);
  }

  watchedOrgIds(): string[] {
    return Array.from(this.subscriberCounts.keys());
  }
}
