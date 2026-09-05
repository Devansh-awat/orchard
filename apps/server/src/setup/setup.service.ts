import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { sanitizeUsername } from '../users/users.service';
import {
  SUPERADMIN_CLAIM_KEY,
  CLAIM_TTL_MS,
  ClaimRecord,
  hashClaimToken,
  claimUrl,
} from './setup-token';

export { SUPERADMIN_CLAIM_KEY };

@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureClaimToken();
    } catch (e) {
      this.logger.error(`could not prepare the superadmin claim: ${e}`);
    }
  }

  private async hasSuperAdmin(): Promise<boolean> {
    const count = await this.prisma.user.count({ where: { isSuperAdmin: true } });
    return count > 0;
  }

  private async readClaim(): Promise<ClaimRecord | null> {
    const raw = await this.settings.get(SUPERADMIN_CLAIM_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ClaimRecord;
      if (!parsed?.hash || !parsed?.expiresAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private static expired(claim: ClaimRecord): boolean {
    return Date.parse(claim.expiresAt) <= Date.now();
  }

  async ensureClaimToken(): Promise<void> {
    if (await this.hasSuperAdmin()) {
      await this.settings.delete(SUPERADMIN_CLAIM_KEY);
      return;
    }

    const existing = await this.readClaim();
    if (existing && !SetupService.expired(existing)) {
      this.logger.warn('This instance still has no superadmin. Redeem the claim token already issued, or restart the server to mint a new one.');
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const record: ClaimRecord = {
      hash: hashClaimToken(token),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
    };

    if (existing) {
      await this.settings.set(SUPERADMIN_CLAIM_KEY, JSON.stringify(record));
    } else if (!(await this.settings.createIfAbsent(SUPERADMIN_CLAIM_KEY, JSON.stringify(record)))) {
      return;
    }

    this.logger.warn(
      [
        '',
        '  This instance has no superadmin yet.',
        '  Open this URL to claim it and sign in (valid for 24 hours):',
        '',
        `    ${claimUrl(token)}`,
        '',
        '  Lost it? Run `orchard-claim` on the host for a fresh one.',
        '',
      ].join('\n'),
    );
  }

  async getStatus(): Promise<{ claimable: boolean }> {
    if (await this.hasSuperAdmin()) return { claimable: false };
    const claim = await this.readClaim();
    return { claimable: Boolean(claim) && !SetupService.expired(claim) };
  }

  private async assertTokenValid(token: string): Promise<void> {
    const supplied = (token || '').trim();
    if (!supplied) throw new BadRequestException('A claim token is required');

    const claim = await this.readClaim();
    if (!claim) throw new BadRequestException('This instance has already been claimed');
    if (SetupService.expired(claim)) {
      throw new BadRequestException('That claim token has expired. Run `orchard-claim` to mint a new one.');
    }

    const a = Buffer.from(hashClaimToken(supplied), 'hex');
    const b = Buffer.from(claim.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('That claim token is not valid');
    }
  }

  async claim(userId: string, token: string): Promise<{ ok: true }> {
    await this.assertTokenValid(token);

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.instanceSetting.deleteMany({ where: { key: SUPERADMIN_CLAIM_KEY } });
      if (deleted.count === 0) throw new BadRequestException('This instance has already been claimed');
      await tx.user.update({ where: { id: userId }, data: { isSuperAdmin: true } });
    });

    this.logger.warn(`user ${userId} claimed superadmin on this instance`);
    return { ok: true };
  }

  /**
   * Claim without an existing session. An instance with no email transport and
   * no identity provider cannot deliver an OTP, so requiring a session here is
   * a deadlock: the operator can't sign in, and can't register the passkey that
   * would let them sign in next time.
   *
   * Possession of the token is the credential, and it is only ever printed to
   * the server log or handed over by `orchard-claim` on the host itself, so
   * this grants nothing to anyone who didn't already have the box. The
   * single-use delete inside the transaction is what stops it being replayed.
   */
  async bootstrap(token: string, email: string): Promise<{ id: string; email: string; username: string; firstName: string | null; lastName: string | null }> {
    // Validated in here rather than by the caller: this is the one path that
    // grants superadmin without a session, so it must not be possible to reach
    // the grant by forgetting a check at the controller.
    await this.assertTokenValid(token);

    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new BadRequestException('An email address is required to claim this instance');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    const user = existing ?? (await this.createUser(normalizedEmail));

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.instanceSetting.deleteMany({ where: { key: SUPERADMIN_CLAIM_KEY } });
      if (deleted.count === 0) throw new BadRequestException('This instance has already been claimed');
      await tx.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
    });

    this.logger.warn(`${normalizedEmail} claimed superadmin on this instance`);
    return user;
  }

  async verifyClaimToken(token: string): Promise<void> {
    return this.assertTokenValid(token);
  }

  private async createUser(normalizedEmail: string) {
    const base = sanitizeUsername(normalizedEmail.split('@')[0]);
    let username = base;
    let counter = 1;
    while (await this.prisma.user.findUnique({ where: { username } })) {
      username = `${base}${counter}`;
      counter += 1;
    }

    // Not emailVerified: nothing has proven this address, the token proved the
    // host. Verification happens the first time email actually works.
    return this.prisma.user.create({
      data: { email: normalizedEmail, username },
    });
  }
}
