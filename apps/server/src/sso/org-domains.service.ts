import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
  Optional
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Resolver } from 'dns/promises';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainRegistrationService, classifyDomain } from '../auth/domain-registration';

export const CHALLENGE_PREFIX = '_orchard-challenge';

// A domain label is 1-63 chars; the whole name caps at 253. Rejecting anything
// else keeps junk out of the DNS query we are about to make on the caller's
// behalf.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Verification is a network call triggered by an unauthenticated-ish action
// (an org admin, but still), so it is worth not letting one org hammer DNS.
const VERIFY_COOLDOWN_MS = 10_000;

export const RECHECK_EVERY_MS = 24 * 60 * 60_000;
export const MISSING_GRACE_MS = 72 * 60 * 60_000;
const RECHECK_BATCH = 200;

type RecheckOutcome = 'kept' | 'missing' | 'revoked' | 'unknown';

export interface DomainRecord {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  recordName: string;
  recordType: 'TXT';
  recordValue: string;
}

@Injectable()
export class OrgDomainsService {
  private readonly logger = new Logger(OrgDomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly registry?: DomainRegistrationService
  ) {}

  normalizeDomain(input: string): string {
    const domain = (input || '')
      .toLowerCase()
      .trim()
      .replace(/^@/, '')
      // Accept a pasted URL or an email address and keep just the host part.
      .replace(/^[a-z]+:\/\//, '')
      .replace(/^[^@/]*@/, '')
      .split('/')[0]
      .replace(/\.$/, '');

    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException('Enter a domain like acme.com');
    }
    const { kind } = classifyDomain(domain);
    if (kind === 'public_suffix' || kind === 'invalid') {
      throw new BadRequestException(
        `${domain} is a public suffix that nobody owns. Add the domain your organization registered.`
      );
    }
    if (kind === 'private_suffix') {
      throw new BadRequestException(
        `${domain} is handed out by a hosting platform, so owning it doesn't prove you own its mailboxes. Add a domain your organization registered.`
      );
    }
    return domain;
  }

  private toRecord(row: {
    id: string;
    domain: string;
    verifiedAt: Date | null;
    lastCheckedAt: Date | null;
    lastError: string | null;
    verificationToken: string;
  }): DomainRecord {
    return {
      id: row.id,
      domain: row.domain,
      verified: row.verifiedAt !== null,
      verifiedAt: row.verifiedAt,
      lastCheckedAt: row.lastCheckedAt,
      lastError: row.lastError,
      recordName: `${CHALLENGE_PREFIX}.${row.domain}`,
      recordType: 'TXT',
      recordValue: row.verificationToken
    };
  }

  async list(organizationId: string): Promise<DomainRecord[]> {
    const rows = await this.prisma.orgDomain.findMany({
      where: { organizationId },
      orderBy: [{ verifiedAt: 'desc' }, { domain: 'asc' }]
    });
    return rows.map((r) => this.toRecord(r));
  }

  /** Domains this org has actually proved it owns. */
  async verifiedDomains(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.orgDomain.findMany({
      where: { organizationId, verifiedAt: { not: null } },
      select: { domain: true }
    });
    return rows.map((r) => r.domain);
  }

  /** The org that owns this domain, if anyone has proved it. */
  async ownerOf(domain: string): Promise<string | null> {
    const row = await this.prisma.orgDomain.findFirst({
      where: { domain: domain.toLowerCase(), verifiedAt: { not: null } },
      select: { organizationId: true }
    });
    return row?.organizationId ?? null;
  }

  async isVerifiedFor(organizationId: string, domain: string): Promise<boolean> {
    if (!domain) return false;
    const row = await this.prisma.orgDomain.findFirst({
      where: { organizationId, domain: domain.toLowerCase(), verifiedAt: { not: null } },
      select: { id: true }
    });
    return Boolean(row);
  }

  async add(
    organizationId: string,
    input: string,
    actor: { userId: string; email?: string }
  ): Promise<DomainRecord> {
    const domain = this.normalizeDomain(input);

    const existing = await this.prisma.orgDomain.findUnique({
      where: { organizationId_domain: { organizationId, domain } }
    });
    if (existing) return this.toRecord(existing);

    // Someone else holding it verified is the one case worth refusing up front;
    // otherwise we would hand out a token that can never succeed.
    const owner = await this.ownerOf(domain);
    if (owner && owner !== organizationId) {
      throw new ConflictException('That domain is already verified by another organization');
    }

    const created = await this.prisma.orgDomain.create({
      data: {
        organizationId,
        domain,
        verificationToken: `orchard-verify-${randomBytes(16).toString('hex')}`
      }
    });

    void this.audit.log({
      action: 'org.domain.added',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId,
      targetType: 'org_domain',
      targetId: created.id,
      targetLabel: domain
    });

    return this.toRecord(created);
  }

  async remove(
    organizationId: string,
    domainId: string,
    actor: { userId: string; email?: string }
  ) {
    const row = await this.prisma.orgDomain.findUnique({ where: { id: domainId } });
    if (!row || row.organizationId !== organizationId) {
      throw new NotFoundException('Domain not found');
    }
    await this.prisma.orgDomain.delete({ where: { id: domainId } });

    void this.audit.log({
      action: 'org.domain.removed',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId,
      targetType: 'org_domain',
      targetId: domainId,
      targetLabel: row.domain,
      metadata: { wasVerified: row.verifiedAt !== null }
    });

    return { success: true };
  }

  /**
   * Look for the challenge token in DNS.
   *
   * Split out so the lookup can be exercised without the database, and so the
   * resolver's own timeout is bounded: a domain pointed at a black-holed
   * nameserver would otherwise hang the request.
   */
  async lookupChallenge(domain: string): Promise<string[]> {
    const resolver = new Resolver({ timeout: 5_000, tries: 2 });
    const records = await resolver.resolveTxt(`${CHALLENGE_PREFIX}.${domain}`);
    // resolveTxt returns one array of chunks per record; a long value gets
    // split across 255-byte strings that have to be rejoined before comparing.
    return records.map((chunks) => chunks.join('').trim());
  }

  async verify(
    organizationId: string,
    domainId: string,
    actor: { userId: string; email?: string }
  ): Promise<DomainRecord> {
    const row = await this.prisma.orgDomain.findUnique({ where: { id: domainId } });
    if (!row || row.organizationId !== organizationId) {
      throw new NotFoundException('Domain not found');
    }
    if (row.verifiedAt) return this.toRecord(row);

    if (row.lastCheckedAt && Date.now() - row.lastCheckedAt.getTime() < VERIFY_COOLDOWN_MS) {
      throw new BadRequestException('DNS may take a few minutes. Check again later.');
    }

    let found: string[] = [];
    let failure: string | null = null;
    try {
      found = await this.lookupChallenge(row.domain);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      failure =
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? 'No TXT record found yet. DNS changes can take a few minutes to appear.'
          : `Couldn't read DNS for that domain (${code || 'lookup failed'})`;
    }

    if (!failure && !found.includes(row.verificationToken)) {
      failure = found.length
        ? "Found a TXT record, but the value doesn't match. Check for an old record."
        : 'No TXT record found yet. DNS changes can take a few minutes to appear.';
    }

    if (failure) {
      const updated = await this.prisma.orgDomain.update({
        where: { id: domainId },
        data: { lastCheckedAt: new Date(), lastError: failure }
      });
      return this.toRecord(updated);
    }

    // Re-check exclusivity at the moment of writing: another org could have
    // verified the same domain while this one was editing DNS. The partial
    // unique index is the real guarantee; this turns the raw constraint error
    // into something the admin can act on.
    try {
      const registeredAt = (await this.registry?.registeredAt(row.domain)) ?? null;
      const verified = await this.prisma.orgDomain.update({
        where: { id: domainId },
        data: {
          verifiedAt: new Date(),
          lastCheckedAt: new Date(),
          lastError: null,
          missingSince: null,
          registeredAt
        }
      });

      void this.audit.log({
        action: 'org.domain.verified',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        organizationId,
        targetType: 'org_domain',
        targetId: domainId,
        targetLabel: row.domain
      });
      this.logger.log(`Domain ${row.domain} verified for org ${organizationId}`);

      return this.toRecord(verified);
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException('That domain was just verified by another organization');
      }
      throw err;
    }
  }

  /**
   * Verification is a fact about who held the domain on one day. Re-check
   * every verified domain daily so a lapsed or sold domain stops vouching for
   * its old organization. A DNS error proves nothing, so only a definite
   * NXDOMAIN, an empty answer or a missing token counts as missing, and only
   * after MISSING_GRACE_MS. A later RDAP registration date is definite on its
   * own: the domain was re-registered, whatever its TXT records say now.
   */
  async recheckDue(now = new Date()): Promise<Record<RecheckOutcome, number>> {
    const tally: Record<RecheckOutcome, number> = { kept: 0, missing: 0, revoked: 0, unknown: 0 };
    const rows = await this.prisma.orgDomain.findMany({
      where: {
        verifiedAt: { not: null },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date(now.getTime() - RECHECK_EVERY_MS) } }
        ]
      },
      orderBy: { lastCheckedAt: 'asc' },
      take: RECHECK_BATCH
    });
    for (const row of rows) {
      try {
        tally[await this.recheck(row, now)] += 1;
      } catch (err) {
        tally.unknown += 1;
        this.logger.warn(
          `Re-check of ${row.domain} failed: ${err instanceof Error ? err.message : 'error'}`
        );
      }
    }
    return tally;
  }

  async recheck(
    row: {
      id: string;
      organizationId: string;
      domain: string;
      verificationToken: string;
      verifiedAt: Date | null;
      registeredAt: Date | null;
      missingSince: Date | null;
    },
    now = new Date()
  ): Promise<RecheckOutcome> {
    if (!row.verifiedAt) return 'unknown';

    const registeredAt = await this.registry?.registeredAt(row.domain);
    const baseline = row.registeredAt ?? row.verifiedAt;
    if (registeredAt && registeredAt.getTime() > baseline.getTime()) {
      await this.revoke(row, 'The domain was registered again after it was verified', now);
      return 'revoked';
    }

    let present: boolean | null;
    try {
      present = (await this.lookupChallenge(row.domain)).includes(row.verificationToken);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      present = code === 'ENOTFOUND' || code === 'ENODATA' ? false : null;
    }

    if (present === null) {
      await this.prisma.orgDomain.update({
        where: { id: row.id },
        data: { lastCheckedAt: now, ...(registeredAt && !row.registeredAt ? { registeredAt } : {}) }
      });
      return 'unknown';
    }

    if (present) {
      await this.prisma.orgDomain.update({
        where: { id: row.id },
        data: {
          lastCheckedAt: now,
          lastError: null,
          missingSince: null,
          ...(registeredAt && !row.registeredAt ? { registeredAt } : {})
        }
      });
      return 'kept';
    }

    const missingSince = row.missingSince ?? now;
    if (now.getTime() - missingSince.getTime() >= MISSING_GRACE_MS) {
      await this.revoke(row, 'The verification TXT record was removed', now);
      return 'revoked';
    }
    await this.prisma.orgDomain.update({
      where: { id: row.id },
      data: {
        lastCheckedAt: now,
        missingSince,
        lastError: `The verification TXT record is missing. Put it back before ${new Date(
          missingSince.getTime() + MISSING_GRACE_MS
        ).toISOString()} to keep this domain verified.`
      }
    });
    return 'missing';
  }

  private async revoke(
    row: { id: string; organizationId: string; domain: string },
    reason: string,
    now: Date
  ) {
    await this.prisma.orgDomain.update({
      where: { id: row.id },
      data: {
        verifiedAt: null,
        missingSince: null,
        registeredAt: null,
        lastCheckedAt: now,
        lastError: `${reason}. Verify it again with the new record below.`,
        verificationToken: `orchard-verify-${randomBytes(16).toString('hex')}`
      }
    });
    void this.audit.log({
      action: 'org.domain.revoked',
      actorUserId: null,
      organizationId: row.organizationId,
      targetType: 'org_domain',
      targetId: row.id,
      targetLabel: row.domain,
      metadata: { reason }
    });
    this.logger.warn(
      `Revoked verification of ${row.domain} for org ${row.organizationId}: ${reason}`
    );
  }
}
