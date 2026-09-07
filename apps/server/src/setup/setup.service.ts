import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { sanitizeUsername } from '../users/users.service';
import { AdminService } from '../admin/admin.service';
import { GithubAppConfigService } from '../github/github-app-config.service';
import { formatSlug, PLATFORM_WILDCARD_DOMAINS } from '../projects/projects.utils';
import {
  SUPERADMIN_CLAIM_KEY,
  CLAIM_TTL_MS,
  ClaimRecord,
  hashClaimToken,
  claimUrl,
} from './setup-token';

export { SUPERADMIN_CLAIM_KEY };

// Everything except the passkey. See skipSetupStep for why that one is absent.
const SKIPPABLE_STEPS = new Set(['organization', 'deploy']);

export interface SetupStep {
  id: 'passkey' | 'organization' | 'deploy';
  done: boolean;
  skipped: boolean;
  required: boolean;
}

export interface SetupState {
  steps: SetupStep[];
  complete: boolean;
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  severity: 'normal' | 'warning';
  href?: string;
}

function envSet(...names: string[]): boolean {
  return names.every((name) => !!(process.env[name] || '').trim());
}

@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
    private readonly admin: AdminService,
    private readonly githubApp: GithubAppConfigService,
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

  /**
   * First-run setup, described so the UI can render a gate over it.
   *
   * `done` is always derived from the thing the step produces, never stored: a
   * stored flag drifts the moment someone deletes their only passkey or their
   * org, and the whole point of the gate is that it reflects whether the
   * instance actually works.
   */
  async getSetupState(userId: string): Promise<SetupState> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, setupSkipped: true },
    });
    if (!user) throw new BadRequestException('Unknown user');

    const [passkeys, orgs, deployments] = await Promise.all([
      this.prisma.passkey.count({ where: { userId } }),
      this.prisma.organizationMember.count({ where: { userId } }),
      this.prisma.deployment.count({
        where: { project: { organization: { members: { some: { userId } } } } },
      }),
    ]);

    const skipped = new Set(user.setupSkipped ?? []);
    const steps: SetupStep[] = [
      // Unskippable: on an instance with no email transport, a session that
      // ends with no passkey registered locks the operator out of their own
      // instance and there is no self-service way back in.
      { id: 'passkey', done: passkeys > 0, skipped: false, required: true },
      // The org already exists (created at claim time), so this step is only
      // about naming it. Skipping keeps the derived default.
      { id: 'organization', done: orgs > 0, skipped: skipped.has('organization'), required: false },
      { id: 'deploy', done: deployments > 0, skipped: skipped.has('deploy'), required: false },
    ];

    return { steps, complete: steps.every((step) => step.done || step.skipped) };
  }

  async skipSetupStep(userId: string, step: string): Promise<SetupState> {
    if (!SKIPPABLE_STEPS.has(step)) {
      // Enforced here rather than only in the UI: the rule is that no skip may
      // leave Orchard unusable, and a rule that only exists in the client is
      // not a rule.
      throw new BadRequestException(`The "${step}" step cannot be skipped`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { setupSkipped: true },
    });
    const next = Array.from(new Set([...(user?.setupSkipped ?? []), step]));
    await this.prisma.user.update({ where: { id: userId }, data: { setupSkipped: next } });

    return this.getSetupState(userId);
  }

  /**
   * Instance configuration that is optional but worth doing, for the admin
   * area. Everything here is derived from live config rather than a stored
   * checklist, so it cannot disagree with the instance.
   *
   * Nothing on this list breaks Orchard when it is missing, which is exactly
   * why none of it is in the first-run gate.
   */
  getChecklist(): ChecklistItem[] {
    const smtp = envSet('SMTP_HOST');
    const oidc = envSet('AUTH_OAUTH_CLIENT_ID', 'AUTH_OAUTH_CLIENT_SECRET')
      || envSet('HACKCLUB_CLIENT_ID', 'HACKCLUB_CLIENT_SECRET');

    return [
      {
        id: 'github-app',
        title: 'Connect a GitHub App',
        detail: 'Deploy private repos and rebuild automatically when you push.',
        done: this.githubApp.isConfigured(),
        severity: 'normal',
        href: '/setup/github',
      },
      {
        id: 'backups',
        title: 'Configure database backups',
        detail:
          'Managed databases have no backups at all until object storage is configured, so a deleted database cannot be recovered.',
        done: envSet('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'),
        severity: 'warning',
      },
      {
        id: 'smtp',
        title: 'Set up email',
        detail:
          'Needed to email invitations and sign-in codes. Without it, invites still work as copyable links.',
        done: smtp,
        severity: 'normal',
      },
      {
        id: 'oidc',
        title: 'Add an identity provider',
        detail: 'Let people sign in with your existing SSO instead of a code or passkey.',
        done: oidc,
        severity: 'normal',
        href: '/admin/sso',
      },
      {
        id: 'ingress-cname',
        title: 'Set the ingress CNAME',
        detail:
          'The hostname users point custom domains at. Without it, custom-domain DNS validation is skipped.',
        done: envSet('INGRESS_CNAME'),
        severity: 'normal',
      },
      {
        id: 'wildcard-tls',
        title: 'Use a wildcard certificate',
        detail:
          'App URLs get one certificate each today, against a limit of 50 per week per registered domain. A wildcard removes that ceiling.',
        done: PLATFORM_WILDCARD_DOMAINS.some((w) => !!w.secret),
        severity: 'normal',
      },
    ];
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

    // Every other thing Orchard can create hangs off an organization, and there
    // is no self-serve way to make one — the only endpoint is superadmin-only.
    // Leaving the operator to create it themselves is what produced instances
    // with no org, and losing your last org resets setupCompleted, so that
    // state bounces you back into setup forever. Create it here so "has an org"
    // is an invariant rather than a step someone can skip.
    await this.ensureOrganizationFor(user.id, normalizedEmail);

    this.logger.warn(`${normalizedEmail} claimed superadmin on this instance`);
    return user;
  }

  /**
   * The first organization, named after the email domain. Idempotent: a user
   * who already belongs to one keeps it.
   */
  private async ensureOrganizationFor(userId: string, email: string): Promise<void> {
    try {
      const existing = await this.prisma.organizationMember.count({ where: { userId } });
      if (existing > 0) return;

      const domain = email.split('@')[1] || '';
      const label = domain.split('.')[0] || email.split('@')[0] || 'orchard';
      const name = label.charAt(0).toUpperCase() + label.slice(1);

      let slug = formatSlug(label) || 'orchard';
      for (let attempt = 1; attempt < 50; attempt += 1) {
        if (!(await this.prisma.organization.findUnique({ where: { slug } }))) break;
        slug = `${formatSlug(label) || 'orchard'}-${attempt}`;
      }

      await this.admin.createOrganization({ name, slug, primaryOwnerEmail: email }, userId);
      this.logger.warn(`created organization ${slug} for ${email}`);
    } catch (e: any) {
      // A claim that half-succeeds is worse than one with no org: the token is
      // already spent by this point, so failing here would strand the operator
      // with no way to retry. The setup flow reports a missing org instead.
      this.logger.error(`could not create the first organization: ${e?.message || e}`);
    }
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
