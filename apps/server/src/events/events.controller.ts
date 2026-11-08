import {
  Controller,
  Param,
  Query,
  Request,
  NotFoundException,
  Sse,
  MessageEvent
} from '@nestjs/common';
import {
  Observable,
  merge,
  interval,
  map,
  finalize,
  defer,
  concat,
  from,
  mergeMap,
  takeUntil
} from 'rxjs';
import { Auth } from '../auth/decorators';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { AuthorizationService } from '../auth/authorization.service';
import { OrgEventsService } from './org-events.service';
import { SseStreamLimiter } from './sse-stream-limiter';
import { SsePreflight } from './sse-preflight.guard';

@Auth()
@Controller('events')
export class EventsController {
  constructor(
    private readonly orgEvents: OrgEventsService,
    private readonly memberships: MembershipCacheService,
    private readonly authz: AuthorizationService,
    private readonly streams: SseStreamLimiter
  ) {}

  // Runs as a guard (see SsePreflight): a caller outside the org is refused with
  // a plain 404 instead of an empty 200 stream.
  async preflightOrg(req): Promise<void> {
    const orgId = req.params.orgId;
    if (!(await this.authz.isSuperAdmin(req.user.sub))) {
      const orgMemberships = await this.memberships.getMembershipsForOrg(req.user.sub, orgId);
      if (orgMemberships.length === 0) {
        throw new NotFoundException('Organization not found');
      }
    }
    await this.authz.listVisibleProjectIds(orgId, req.user.sub);
  }

  @SsePreflight('preflightOrg')
  @Sse('orgs/:orgId')
  async streamOrg(
    @Param('orgId') orgId: string,
    @Query('lastEventId') lastEventIdQuery: string | undefined,
    @Request() req
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
    // Refreshed on every access recheck; the stream ends when org membership is lost.
    let visibleProjectIds = await this.authz.listVisibleProjectIds(orgId, userId);
    const visible = () => visibleProjectIds;
    const reauthorize = async () => {
      visibleProjectIds = await this.authz.listVisibleProjectIds(orgId, userId);
    };

    // 25s heartbeat so proxies don't kill idle SSE connections.
    const heartbeat$ = interval(25_000).pipe(
      map(() => ({ data: { type: 'heartbeat', ts: Date.now() } }))
    );

    const release = this.streams.acquire(userId, `org:${orgId}`);
    const accessLost$ = this.streams.untilAccessLost(req.auth, reauthorize);

    // Track subscriber count per org so server-side pushers (metrics emitter)
    // can skip orgs nobody is currently watching.
    return defer(() => {
      this.orgEvents.addSubscriber(orgId);
      const live$ = this.orgEvents.forOrgAsSseScoped(orgId, userId, visible);
      const events$ = lastEventId
        ? concat(
            from(this.orgEvents.replayScoped(lastEventId, orgId, userId, visible)).pipe(
              mergeMap((msgs) => from(msgs))
            ),
            live$
          )
        : live$;
      return merge(events$, heartbeat$).pipe(takeUntil(accessLost$));
    }).pipe(
      finalize(() => {
        this.orgEvents.removeSubscriber(orgId);
        release();
      })
    ) as Observable<MessageEvent>;
  }
}
