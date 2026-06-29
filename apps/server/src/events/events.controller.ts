import { Controller, Param, Query, Request, NotFoundException, Sse, MessageEvent } from '@nestjs/common';
import { Observable, merge, interval, map, finalize, defer, concat, from, mergeMap } from 'rxjs';
import { Auth } from '../auth/decorators';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { AuthorizationService } from '../auth/authorization.service';
import { OrgEventsService } from './org-events.service';

@Auth()
@Controller('events')
export class EventsController {
  constructor(
    private readonly orgEvents: OrgEventsService,
    private readonly memberships: MembershipCacheService,
    private readonly authz: AuthorizationService,
  ) {}

  @Sse('orgs/:orgId')
  async streamOrg(
    @Param('orgId') orgId: string,
    @Query('lastEventId') lastEventIdQuery: string | undefined,
    @Request() req,
  ): Promise<Observable<MessageEvent>> {
    const userId = req.user.sub;
    const lastEventId =
      (typeof req.headers?.['last-event-id'] === 'string'
        ? req.headers['last-event-id']
        : undefined) || lastEventIdQuery;
    const isSuperAdmin = await this.authz.isSuperAdmin(userId);
    if (!isSuperAdmin) {
      const orgMemberships = await this.memberships.getMembershipsForOrg(userId, orgId);
      if (orgMemberships.length === 0) {
        throw new NotFoundException('Organization not found');
      }
    }

    // H3: scope the SSE stream to projects the user can actually see.
    // null => org admin/owner/superadmin (see all); array => plain member's allowed project IDs.
    // Captured at subscribe time; role changes mid-stream are handled by the client
    // tearing down on membership.changed for this user (server still drops cross-project events).
    const visibleProjectIds = await this.authz.listVisibleProjectIds(orgId, userId);

    // 25s heartbeat so proxies don't kill idle SSE connections.
    const heartbeat$ = interval(25_000).pipe(
      map(() => ({ data: { type: 'heartbeat', ts: Date.now() } })),
    );

    // Track subscriber count per org so server-side pushers (metrics emitter)
    // can skip orgs nobody is currently watching.
    return defer(() => {
      this.orgEvents.addSubscriber(orgId);
      const live$ = this.orgEvents.forOrgAsSseScoped(orgId, userId, visibleProjectIds);
      const events$ = lastEventId
        ? concat(
            from(
              this.orgEvents.replayScoped(lastEventId, orgId, userId, visibleProjectIds),
            ).pipe(mergeMap((msgs) => from(msgs))),
            live$,
          )
        : live$;
      return merge(events$, heartbeat$);
    }).pipe(finalize(() => this.orgEvents.removeSubscriber(orgId))) as Observable<MessageEvent>;
  }
}
