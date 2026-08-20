import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';

export const SUPERADMIN_CLAIM_KEY = 'superadmin_claim';

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

interface ClaimRecord {
  hash: string;
  expiresAt: string;
}

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

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
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
      hash: SetupService.hashToken(token),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
    };

    if (existing) {
      await this.settings.set(SUPERADMIN_CLAIM_KEY, JSON.stringify(record));
    } else if (!(await this.settings.createIfAbsent(SUPERADMIN_CLAIM_KEY, JSON.stringify(record)))) {
      return;
    }

    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    this.logger.warn(
      [
        '',
        '  This instance has no superadmin yet.',
        '  Sign in, then open this URL to claim it (valid for 24 hours):',
        '',
        `    ${base}/setup/claim?token=${token}`,
        '',
      ].join('\n'),
    );
  }

  async getStatus(): Promise<{ claimable: boolean }> {
    if (await this.hasSuperAdmin()) return { claimable: false };
    const claim = await this.readClaim();
    return { claimable: Boolean(claim) && !SetupService.expired(claim) };
  }

  async claim(userId: string, token: string): Promise<{ ok: true }> {
    const supplied = (token || '').trim();
    if (!supplied) throw new BadRequestException('A claim token is required');

    const claim = await this.readClaim();
    if (!claim) throw new BadRequestException('This instance has already been claimed');
    if (SetupService.expired(claim)) {
      throw new BadRequestException('That claim token has expired. Restart the server to mint a new one.');
    }

    const a = Buffer.from(SetupService.hashToken(supplied), 'hex');
    const b = Buffer.from(claim.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('That claim token is not valid');
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.instanceSetting.deleteMany({ where: { key: SUPERADMIN_CLAIM_KEY } });
      if (deleted.count === 0) throw new BadRequestException('This instance has already been claimed');
      await tx.user.update({ where: { id: userId }, data: { isSuperAdmin: true } });
    });

    this.logger.warn(`user ${userId} claimed superadmin on this instance`);
    return { ok: true };
  }
}
