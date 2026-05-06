import { Controller, Param, Request, ForbiddenException, Sse, MessageEvent } from '@nestjs/common';
import { Observable, merge, interval, map, finalize, defer } from 'rxjs';
import { Auth } from '../auth/decorators';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { OrgEventsService } from './org-events.service';

@Auth()
@Controller('events')
export class EventsController {
  constructor(
    private readonly orgEvents: OrgEventsService,
    private readonly memberships: MembershipCacheService,
  ) {}

  @Sse('orgs/:orgId')
  async streamOrg(
    @Param('orgId') orgId: string,
    @Request() req,
  ): Promise<Observable<MessageEvent>> {
    const userId = req.user.sub;
    const orgMemberships = await this.memberships.getMembershipsForOrg(userId, orgId);
    if (orgMemberships.length === 0) {
      throw new ForbiddenException('Not a member of this organization');
    }

    // 25s heartbeat so proxies don't kill idle SSE connections.
    const heartbeat$ = interval(25_000).pipe(
      map(() => ({ data: { type: 'heartbeat', ts: Date.now() } })),
    );

    // Track subscriber count per org so server-side pushers (metrics emitter)
    // can skip orgs nobody is currently watching.
    return defer(() => {
      this.orgEvents.addSubscriber(orgId);
      return merge(this.orgEvents.forOrgAsSse(orgId), heartbeat$);
    }).pipe(finalize(() => this.orgEvents.removeSubscriber(orgId))) as Observable<MessageEvent>;
  }
}
