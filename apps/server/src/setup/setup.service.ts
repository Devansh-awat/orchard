import { Injectable, Logger, OnModuleInit, BadRequestException, Optional } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { EMAIL, INGRESS, WILDCARD } from '../instance-config/instance-config.sections';
import { platformBackupTarget } from '../instance-config/object-storage';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { DnsCheckService, DnsReport } from '../instance-network/dns-check.service';
import { sanitizeUsername } from '../users/users.service';
import { AdminService } from '../admin/admin.service';
import { GithubAppConfigService } from '../github/github-app-config.service';
import { formatSlug, platformWildcardDomains } from '../projects/projects.utils';
import {
  SUPERADMIN_CLAIM_KEY,
  CLAIM_TTL_MS,
  ClaimRecord,
  hashClaimToken,
  claimUrl,
  recoveryState
} from './setup-token';

export { SUPERADMIN_CLAIM_KEY };

// Everything except the passkey. See skipSetupStep for why that one is absent.
const SKIPPABLE_STEPS = new Set(['organization']);

export interface SetupStep {
  id: 'passkey' | 'organization';
  done: boolean;
  skipped: boolean;
  required: boolean;
}

export interface SetupState {
  steps: SetupStep[];
  complete: boolean;
}

// The checklist is read on every superadmin page load for the sidebar badge,
// and it reports live certificate state, so an uncached read would put a
// Kubernetes API call behind a UI badge. Short enough that the setup flow's
// own polling still sees the certificate land promptly.
const CERT_TTL_MS = 10_000;

export interface SetupCertificate {
  state: 'ready' | 'issuing' | 'failed' | 'rateLimited' | 'unknown' | 'unconfigured' | 'perHost';
  host: string | null;
  message: string | null;
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  severity: 'normal' | 'warning';
  href?: string;
}

// The name an untouched organization carries, derived from the email domain.
// Shared so the setup step can tell "still the default" from "renamed".
function orgLabelFor(email: string): string {
  const domain = email.split('@')[1] || '';
  return domain.split('.')[0] || email.split('@')[0] || 'orchard';
}

export function defaultOrgName(email: string): string {
  const label = orgLabelFor(email);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function envSet(...names: string[]): boolean {
  return names.every((name) => !!(process.env[name] || '').trim());
}

@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  private certCache: { key: string; at: number; value: SetupCertificate } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
    private readonly admin: AdminService,
    private readonly githubApp: GithubAppConfigService,
    private readonly config: InstanceConfigService,
    private readonly dns: DnsCheckService,
    @Optional() private readonly network?: K8sNetworkService
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureClaimToken();
    } catch (e) {
      this.logger.error(`could not prepare the superadmin claim: ${e}`);
    }
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
    const state = await recoveryState(this.prisma);

    // A claim token is only ever deleted once there is some other way to sign
    // in as the superadmin. Deleting it merely because a superadmin exists is
    // what made `orchardctl claim` useless for recovery: the link it minted was
    // wiped by the next boot, and with two replicas that is seconds later.
    // Tying the sweep to the same rule also closes the window on its own, the
    // moment the operator adds a passkey.
    if (!state.claimable) {
      await this.settings.delete(SUPERADMIN_CLAIM_KEY);
      return;
    }

    const existing = await this.readClaim();
    if (existing && !SetupService.expired(existing)) {
      this.logger.warn(
        'This instance still has no superadmin. Redeem the claim token already issued, or restart the server to mint a new one.'
      );
      return;
    }

    // Minting is left to `orchardctl claim` once a superadmin exists. Doing it
    // here would leave a live superadmin-granting token standing on every
    // instance whose operator simply has not added a passkey yet.
    if (state.superadmins > 0) return;

    const token = randomBytes(32).toString('base64url');
    const record: ClaimRecord = {
      hash: hashClaimToken(token),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString()
    };

    if (existing) {
      await this.settings.set(SUPERADMIN_CLAIM_KEY, JSON.stringify(record));
    } else if (
      !(await this.settings.createIfAbsent(SUPERADMIN_CLAIM_KEY, JSON.stringify(record)))
    ) {
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
        ''
      ].join('\n')
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
      select: { id: true, email: true, setupSkipped: true }
    });
    if (!user) throw new BadRequestException('Unknown user');

    // Self-healing rather than only at claim time. Whether an account has an
    // organization is an invariant the rest of Orchard depends on, and it has
    // to hold for accounts that predate the auto-creation, and for the claim
    // path taken while already signed in. Idempotent.
    if (user.email) await this.ensureOrganizationFor(user.id, user.email);

    const [passkeys, named, withPassword] = await Promise.all([
      this.prisma.passkey.count({ where: { userId } }),
      this.prisma.organization.findMany({
        where: { members: { some: { userId } } },
        select: { name: true }
      }),
      this.prisma.user.count({ where: { id: userId, passwordHash: { not: null } } })
    ]);
    const orgs = named.length;
    const hasPassword = withPassword > 0;

    const skipped = new Set(user.setupSkipped ?? []);
    const steps: SetupStep[] = [
      // Unskippable, because a session that ends with no way back in locks the
      // operator out of their own instance. A passkey is the good answer and
      // needs TLS; a password is the one that works on a LAN box served over
      // plain HTTP, where the passkey API is not available at all. Either
      // satisfies this, and until one exists the step stands.
      {
        id: 'passkey',
        done: passkeys > 0 || hasPassword,
        skipped: false,
        required: true
      },
      // Not `orgs > 0`: the org is created at claim time, so that is true from
      // the first moment and the step would never render. What is outstanding
      // is that it still carries the name derived from the email domain, and
      // the point of showing this step at all is that orgs are a concept
      // people should meet rather than have quietly appear around them.
      {
        id: 'organization',
        done: orgs > 0 && !named.some((org) => org.name === defaultOrgName(user.email ?? '')),
        skipped: skipped.has('organization'),
        required: false
      }
    ];

    // An org is required, not merely a step: skipping the organization step is
    // only safe because one already exists. If creation failed, letting setup
    // complete would leave an account that cannot create anything, which is the
    // exact outcome the gate exists to prevent. The step's own no-org branch
    // offers a way into the admin area, so this cannot trap anyone.
    const settled = steps.every((step) => step.done || step.skipped);
    return { steps, complete: settled && orgs > 0 };
  }

  /**
   * The wildcard certificate for this instance, straight off cert-manager.
   *
   * Nobody can act on this from the setup flow, so it is deliberately not a
   * SetupStep and never gates `complete`. It is reported so the last screen can
   * say what is actually happening instead of spinning: `unconfigured` (no app
   * domain) and `unknown` (no cert-manager, or no RBAC to read it) are both
   * ordinary outcomes on a self-hosted box, not failures.
   */
  async getCertificate(): Promise<SetupCertificate> {
    const wildcard = platformWildcardDomains()[0];
    const host = wildcard ? `*${wildcard.suffix}` : null;
    // No app domain at all is a real gap: nothing can generate a URL.
    if (!wildcard) return { state: 'unconfigured', host: null, message: null };
    // A domain with no wildcard Secret named is the stock install, not a fault.
    // Each generated host gets its own certificate from certClusterIssuer,
    // which needs no DNS-01 and no way to copy a Secret between namespaces.
    // Reporting it as "unconfigured" told operators their app domain was
    // missing when they had just set it.
    if (!wildcard.secret) return { state: 'perHost', host, message: null };

    const namespace = this.config.value(WILDCARD, 'sourceNamespace')?.trim();
    if (!namespace || !this.network) return { state: 'unknown', host, message: null };

    const cached = this.certCache;
    if (
      cached &&
      cached.key === `${namespace}/${wildcard.secret}` &&
      cached.at > Date.now() - CERT_TTL_MS
    ) {
      return cached.value;
    }

    const status = await this.network.getCertificateStatus(namespace, wildcard.secret);
    const value: SetupCertificate = {
      state: status.state,
      message: status.message ?? null,
      host
    };
    this.certCache = { key: `${namespace}/${wildcard.secret}`, at: Date.now(), value };
    return value;
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
      select: { setupSkipped: true }
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
  async getChecklist(): Promise<ChecklistItem[]> {
    const smtp = this.config.isConfigured(EMAIL);
    const oidc =
      envSet('AUTH_OAUTH_CLIENT_ID', 'AUTH_OAUTH_CLIENT_SECRET') ||
      envSet('HACKCLUB_CLIENT_ID', 'HACKCLUB_CLIENT_SECRET') ||
      (await this.prisma.identityProvider.count({
        where: { organizationId: null, enabled: true }
      })) > 0;

    const wildcardConfigured = platformWildcardDomains().some((w) => !!w.secret);
    const cert = wildcardConfigured
      ? await this.getCertificate()
      : ({ state: 'unknown', host: null, message: null } as SetupCertificate);
    const wildcardDetail = this.wildcardStatus(wildcardConfigured, cert);

    // A name that does not resolve is not an outage, it is a certificate that
    // never issues, which is invisible until somebody tries the URL. Cheap to
    // surface here, where the operator is already reading a list of what is
    // unfinished.
    let dns: DnsReport | null = null;
    try {
      dns = await this.dns.report();
    } catch (e: any) {
      this.logger.warn(`could not check DNS: ${e?.message}`);
    }
    const dnsOutstanding = DnsCheckService.outstanding(dns);

    return [
      {
        id: 'github-app',
        title: 'Connect a GitHub App',
        detail: 'Deploy private repos and rebuild automatically when you push.',
        done: this.githubApp.isConfigured(),
        severity: 'normal',
        href: '/setup/github'
      },
      {
        id: 'backups',
        title: 'Configure database backups',
        detail:
          'Managed databases have no backups at all until a backup bucket is configured, so a deleted database cannot be recovered.',
        done: platformBackupTarget() !== null,
        severity: 'warning',
        href: '/admin/instance'
      },
      {
        id: 'smtp',
        title: 'Set up email',
        detail:
          'Needed to email invitations and sign-in codes. Without it, invites still work as copyable links.',
        done: smtp,
        severity: 'normal',
        href: '/admin/instance'
      },
      {
        id: 'oidc',
        title: 'Add an identity provider',
        detail: 'Let people sign in with your existing SSO instead of a code or passkey.',
        done: oidc,
        severity: 'normal',
        href: '/admin/sso'
      },
      {
        id: 'ingress-cname',
        title: 'Set the ingress CNAME',
        detail:
          'The hostname users point custom domains at. Without it, custom-domain DNS validation is skipped.',
        done: this.config.isConfigured(INGRESS),
        severity: 'normal',
        href: '/admin/instance'
      },
      {
        id: 'dns',
        title: 'Point DNS at this instance',
        detail: SetupService.dnsDetail(dns, dnsOutstanding.length),
        // Nothing outstanding counts as done, including nothing to check and a
        // check that could not run. An item nobody can ever complete is worse
        // than no item at all.
        done: dnsOutstanding.length === 0,
        severity: dnsOutstanding.length > 0 ? 'warning' : 'normal',
        href: '/admin/networking'
      },
      {
        id: 'wildcard-tls',
        title: 'Use a wildcard certificate',
        detail: wildcardDetail,
        done: wildcardConfigured && cert.state === 'ready',
        severity: cert.state === 'failed' || cert.state === 'rateLimited' ? 'warning' : 'normal',
        href: '/admin/instance'
      }
    ];
  }

  private static dnsDetail(dns: DnsReport | null, outstanding: number): string {
    if (!dns || dns.rows.length === 0) {
      return 'Nothing to check yet: this instance has no domain configured.';
    }
    if (outstanding === 0) {
      return 'Every hostname this instance serves resolves here.';
    }
    const names = DnsCheckService.outstanding(dns)
      .map((r) => r.record)
      .join(', ');
    return `${names} does not point here yet. Certificates cannot issue for a hostname that does not resolve.`;
  }

  /**
   * A configured wildcard is not a working one. The setup flow tells the
   * operator the certificate will turn up here once it lands, so the item has
   * to reflect what cert-manager actually reports rather than only whether a
   * secret name was typed in.
   */
  private wildcardStatus(configured: boolean, cert: SetupCertificate): string {
    const base =
      'App URLs get one certificate each today, against a limit of 50 per week per registered domain. A wildcard removes that ceiling.';
    if (!configured) return base;
    switch (cert.state) {
      case 'ready':
        return 'A wildcard certificate is issued and covering every generated app URL.';
      case 'issuing':
        return `Configured, and cert-manager is still issuing it. ${cert.message ?? ''}`.trim();
      case 'failed':
        return `Configured, but issuance failed. ${cert.message ?? ''}`.trim();
      case 'rateLimited':
        return `Configured, but Let's Encrypt is rate limiting. It will issue on its own once the limit rolls off.`;
      default:
        return 'Configured, but no certificate automation is available to issue it.';
    }
  }

  async getStatus(): Promise<{ claimable: boolean }> {
    // A live token is the whole answer. Refusing whenever a superadmin exists
    // would hide the form from the one case the token is minted for: an
    // operator locked out of an instance that already has them.
    const claim = await this.readClaim();
    if (!claim || SetupService.expired(claim)) return { claimable: false };
    return { claimable: (await recoveryState(this.prisma)).claimable };
  }

  private async assertTokenValid(token: string): Promise<void> {
    const supplied = (token || '').trim();
    if (!supplied) throw new BadRequestException('A claim token is required');

    const claim = await this.readClaim();
    if (!claim) throw new BadRequestException('This instance has already been claimed');
    if (!(await recoveryState(this.prisma)).claimable) {
      throw new BadRequestException('This instance has already been claimed');
    }
    if (SetupService.expired(claim)) {
      throw new BadRequestException(
        'That claim token has expired. Run `orchard-claim` to mint a new one.'
      );
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
      if (deleted.count === 0)
        throw new BadRequestException('This instance has already been claimed');
      await tx.user.update({ where: { id: userId }, data: { isSuperAdmin: true } });
    });

    const claimed = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true }
    });
    if (claimed?.email) await this.ensureOrganizationFor(userId, claimed.email);

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
  async bootstrap(
    token: string,
    email: string
  ): Promise<{
    id: string;
    email: string;
    username: string;
    firstName: string | null;
    lastName: string | null;
  }> {
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
      if (deleted.count === 0)
        throw new BadRequestException('This instance has already been claimed');
      await tx.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
    });

    // Every other thing Orchard can create hangs off an organization, and there
    // is no self-serve way to make one: the only endpoint is superadmin-only.
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

      const label = orgLabelFor(email);
      const name = defaultOrgName(email);

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
      data: { email: normalizedEmail, username }
    });
  }
}
