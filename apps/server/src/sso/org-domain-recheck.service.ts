import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { OrgDomainsService } from './org-domains.service';

export const ORG_DOMAIN_RECHECK_TICK_MS = 60 * 60_000;

@Injectable()
export class OrgDomainRecheckService {
  private readonly logger = new Logger(OrgDomainRecheckService.name);

  private running = false;

  constructor(
    private readonly lease: LeaseService,
    private readonly domains: OrgDomainsService
  ) {}

  @Interval(ORG_DOMAIN_RECHECK_TICK_MS)
  async tick(): Promise<void> {
    if (!this.lease.canCoordinate || !this.lease.isHolder(GLOBAL_LEADER_LEASE) || this.running) {
      return;
    }
    this.running = true;
    try {
      const tally = await this.domains.recheckDue();
      if (tally.revoked || tally.missing) {
        this.logger.warn(
          `Domain re-check: ${tally.revoked} revoked, ${tally.missing} missing, ${tally.kept} kept`
        );
      }
    } catch (err) {
      this.logger.warn(`Domain re-check failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
