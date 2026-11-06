import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger
} from '@nestjs/common';
import { X509Certificate } from 'crypto';
import { IdentityProvider, OrganizationRole, SsoProtocol } from '@prisma/client';
import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SsoCryptoService } from './sso-crypto.service';
import { findPreset, resolveIssuerUrl } from './presets';
import { OrgDomainsService } from './org-domains.service';
import { StorageService } from '../organizations/storage.service';
import {
  BlockedDestinationError,
  assertPublicUrl,
  guardedFetch,
  parseHttpUrl,
  type GuardedFetchInit
} from '../notifications/webhook-guard';

export interface ProviderInput {
  name?: string;
  slug?: string;
  preset?: string;
  protocol?: SsoProtocol;
  enabled?: boolean;
  buttonLabel?: string | null;
  iconUrl?: string | null;
  sortOrder?: number;
  issuerUrl?: string | null;
  tenant?: string | null;
  domain?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userinfoUrl?: string | null;
  samlEntryPoint?: string | null;
  samlIssuer?: string | null;
  samlIdpEntityId?: string | null;
  samlCertificate?: string | null;
  samlMetadataUrl?: string | null;
  jitProvisioning?: boolean;
  defaultRole?: OrganizationRole;
  allowedDomains?: string[];
  requireVerifiedEmail?: boolean;
}

export interface SettingsInput {
  enabled?: boolean;
  enforced?: boolean;
  loginLogoUrl?: string | null;
  loginPrimaryColor?: string | null;
  loginBgColor?: string | null;
  loginWelcomeText?: string | null;
  loginTagline?: string | null;
}

// What admin reads see instead of a stored secret. Writes that echo it back
// are treated as "unchanged" rather than stored, so a client that round-trips
// its own GET can't overwrite a real secret with the mask.
const SECRET_MASK = '••••••••';
const SAML_CERT_MASK = '(configured)';
const METADATA_MAX_BYTES = 512 * 1024;
const MAX_IDP_CERTIFICATES = 4;

function isMask(value: string | null | undefined): boolean {
  return value === SECRET_MASK || value === SAML_CERT_MASK;
}

const RESERVED_PROVIDER_SLUGS = new Set([
  'new',
  'callback',
  'start',
  'metadata',
  'discover',
  'enforcement'
]);

const ORG_ENFORCEMENT_REVOKES = ['oauth', 'otp', 'passkey', 'password'];
const INSTANCE_ENFORCEMENT_REVOKES = ['otp', 'passkey', 'password'];

export interface InstanceEnforcement {
  enabled: boolean;
  dbValue: boolean;
  envOverride: boolean | null;
  providersAvailable: boolean;
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  private readonly backendUrl: string;

  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SsoCryptoService,
    private readonly audit: AuditService,
    private readonly domains: OrgDomainsService,
    private readonly sessions: SessionsService,
    private readonly instanceSettings: InstanceSettingsService,
    private readonly storage: StorageService
  ) {
    this.backendUrl =
      process.env.BACKEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  /**
   * Where the IdP sends the user back. Providers migrated from the old
   * per-org config keep their original path in `callbackPath`, because the
   * redirect URI is registered on the IdP side and moving it breaks the
   * connection until someone updates it there.
   */
  callbackUrl(provider: Pick<IdentityProvider, 'id' | 'callbackPath'>): string {
    return `${this.backendUrl}${provider.callbackPath || `/apiv1/sso/callback/${provider.id}`}`;
  }

  /** SP entity id / SAML audience. Stable per provider. */
  entityId(provider: Pick<IdentityProvider, 'id' | 'organizationId' | 'samlIssuer'>): string {
    return (
      provider.samlIssuer || `orchard-sso-${provider.organizationId ?? 'instance'}-${provider.id}`
    );
  }

  orgLoginUrl(slug: string): string {
    return `${this.frontendUrl}/${slug}/login`;
  }

  async loginUrlForOrg(organizationId: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true }
    });
    return org ? this.orgLoginUrl(org.slug) : null;
  }

  /**
   * Everything the org login page at /<slug> needs. Returns null when the org
   * doesn't exist or SSO isn't live for it, and the caller collapses both into
   * one 404 so this can't be used to enumerate organizations.
   */
  async getOrgLoginContext(slug: string) {
    const org = await this.prisma.organization.findUnique({
      where: { slug: slug.toLowerCase() },
      include: {
        ssoSettings: true,
        identityProviders: {
          where: { enabled: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
        }
      }
    });

    if (!org) return null;
    const settings = org.ssoSettings;
    if (!settings?.enabled || !settings.platformEnabled) return null;

    const providers = org.identityProviders.filter((p) => this.isUsable(p));
    if (providers.length === 0) return null;

    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      avatarUrl: org.avatarUrl,
      enforced: settings.enforced,
      branding: {
        logoUrl: settings.loginLogoUrl,
        primaryColor: settings.loginPrimaryColor,
        bgColor: settings.loginBgColor,
        welcomeText: settings.loginWelcomeText,
        tagline: settings.loginTagline
      },
      providers: providers.map((p) => this.publicProvider(p))
    };
  }

  /**
   * Legacy lookup: vanity subdomains still point at an org's login page. Falls
   * back to reading the label as a slug, because a host like acme.orchard.my
   * is just as likely to be the org's slug as a subdomain someone reserved.
   */
  async getOrgLoginContextBySubdomain(subdomain: string) {
    const label = subdomain.toLowerCase();
    const org = await this.prisma.organization.findFirst({
      where: { subdomain: label },
      select: { slug: true }
    });
    return this.getOrgLoginContext(org?.slug ?? label);
  }

  /** Legacy lookup: the old login URL addressed an org by uuid. */
  async getOrgLoginContextById(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true }
    });
    if (!org) return null;
    return this.getOrgLoginContext(org.slug);
  }

  /**
   * Instance-wide providers rendered on the platform login page.
   *
   * The env-configured provider (AUTH_PROVIDER, the old hardcoded button) is
   * returned alongside the database ones so the login page is a single list
   * and no provider is special-cased in the UI. It keeps its own /auth/login
   * flow: this is a rendering hint, not a re-route.
   */
  async getInstanceProviders() {
    const providers = await this.prisma.identityProvider.findMany({
      where: { organizationId: null, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
    const configured = providers.filter((p) => this.isUsable(p)).map((p) => this.publicProvider(p));
    const env = this.envProvider();
    return env ? [env, ...configured] : configured;
  }

  envProvider() {
    const configured =
      process.env.AUTH_PROVIDER ?? (process.env.HACKCLUB_CLIENT_ID ? 'hackclub' : 'none');
    if (configured === 'none') return null;
    const name =
      process.env.AUTH_PROVIDER_LABEL || (configured === 'hackclub' ? 'Hack Club' : 'SSO');
    return {
      id: 'env',
      slug: 'env',
      name,
      preset: configured === 'hackclub' ? 'hackclub' : 'generic',
      protocol: SsoProtocol.oidc,
      label: `Continue with ${name}`,
      iconUrl: null,
      startUrl: '/apiv1/auth/login',
      source: 'env' as const
    };
  }

  /**
   * Email-domain routing: the "enter your work email" box on the platform login
   * page. Only reveals an org that has claimed the domain AND has SSO live, so
   * a stranger can't map the tenant list by guessing domains.
   */
  async discoverByEmail(email: string) {
    const domain = (email || '').toLowerCase().trim().split('@')[1];
    if (!domain) return null;

    // Only a domain the org has proved it owns routes traffic. A self-asserted
    // claim on gmail.com would otherwise collect every gmail user who typed
    // their address on the platform login page.
    const owner = await this.domains.ownerOf(domain);
    if (!owner) return null;

    const settings = await this.prisma.orgSsoSettings.findFirst({
      where: { organizationId: owner, enabled: true, platformEnabled: true },
      include: { organization: { select: { slug: true, name: true, avatarUrl: true } } }
    });
    if (!settings) return null;

    const providerCount = await this.prisma.identityProvider.count({
      where: { organizationId: settings.organizationId, enabled: true }
    });
    if (providerCount === 0) return null;

    return {
      slug: settings.organization.slug,
      name: settings.organization.name,
      avatarUrl: settings.organization.avatarUrl,
      enforced: settings.enforced,
      loginUrl: `/${settings.organization.slug}/login`
    };
  }

  /**
   * A provider is usable when it has enough config to actually complete a
   * flow. Half-configured rows stay out of the login page rather than
   * rendering a button that dead-ends on the IdP.
   */
  private isUsable(p: IdentityProvider): boolean {
    if (p.protocol === SsoProtocol.saml) {
      return Boolean(p.samlEntryPoint && p.samlCertificate);
    }
    if (p.protocol === SsoProtocol.oauth2) {
      return Boolean(p.clientId && p.authorizationUrl && p.tokenUrl && p.userinfoUrl);
    }
    return Boolean(p.issuerUrl && p.clientId);
  }

  publicProvider(p: IdentityProvider) {
    const preset = findPreset(p.preset);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      preset: p.preset,
      protocol: p.protocol,
      label: p.buttonLabel || preset?.buttonLabel || `Continue with ${p.name}`,
      iconUrl: p.iconUrl,
      startUrl: `/apiv1/sso/start/${p.id}`,
      source: 'database' as const
    };
  }

  /** Admin view: full config with secrets replaced by a presence marker. */
  adminProvider(p: IdentityProvider) {
    return {
      id: p.id,
      organizationId: p.organizationId,
      slug: p.slug,
      name: p.name,
      preset: p.preset,
      protocol: p.protocol,
      enabled: p.enabled,
      buttonLabel: p.buttonLabel,
      iconUrl: p.iconUrl,
      sortOrder: p.sortOrder,
      issuerUrl: p.issuerUrl,
      clientId: p.clientId,
      clientSecret: p.clientSecret ? SECRET_MASK : null,
      scopes: p.scopes,
      authorizationUrl: p.authorizationUrl,
      tokenUrl: p.tokenUrl,
      userinfoUrl: p.userinfoUrl,
      samlEntryPoint: p.samlEntryPoint,
      samlIssuer: p.samlIssuer,
      samlIdpEntityId: p.samlIdpEntityId,
      samlCertificate: p.samlCertificate ? SECRET_MASK : null,
      samlMetadataUrl: p.samlMetadataUrl,
      jitProvisioning: p.jitProvisioning,
      defaultRole: p.defaultRole,
      allowedDomains: p.allowedDomains,
      requireVerifiedEmail: p.requireVerifiedEmail,
      usable: this.isUsable(p),
      lastUsedAt: p.lastUsedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      callbackUrl: this.callbackUrl(p),
      entityId: this.entityId(p),
      metadataUrl:
        p.protocol === SsoProtocol.saml
          ? `${this.backendUrl}/apiv1/sso/providers/${p.id}/metadata`
          : null
    };
  }

  listProviders(organizationId: string | null) {
    return this.prisma.identityProvider
      .findMany({
        where: { organizationId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
      })
      .then((rows) => rows.map((r) => this.adminProvider(r)));
  }

  private async requireProvider(id: string, organizationId: string | null) {
    const provider = await this.prisma.identityProvider.findUnique({ where: { id } });
    if (!provider || provider.organizationId !== organizationId) {
      throw new NotFoundException('Identity provider not found');
    }
    return provider;
  }

  async getProviderForAdmin(id: string, organizationId: string | null) {
    return this.adminProvider(await this.requireProvider(id, organizationId));
  }

  /**
   * JIT provisioning may hand out member/guest/admin, never owner. Org admins
   * can manage SSO, and letting one configure a provider whose next fresh
   * IdP identity lands as owner would be a quiet admin-to-owner escalation.
   */
  private safeDefaultRole(role: OrganizationRole | undefined): OrganizationRole {
    if (!role) return OrganizationRole.member;
    if (role === OrganizationRole.owner) {
      throw new BadRequestException("SSO provisioning can't grant the owner role");
    }
    return role;
  }

  /**
   * Admin-supplied IdP URLs drive server-side fetches, which makes them an
   * SSRF primitive: an org admin is not trusted with cluster-internal HTTP.
   * Resolves DNS and blocks loopback, RFC1918, CGNAT, link-local, and cluster
   * DNS names. Self-hosters whose IdP genuinely lives on internal DNS
   * (in-cluster Keycloak/Dex) can opt out with SSO_ALLOW_INTERNAL_IDP=true.
   */
  private async assertIdpUrl(raw: string | null | undefined, label: string): Promise<void> {
    if (!raw) return;
    if (this.allowInternalIdp()) {
      parseHttpUrl(raw, label);
      return;
    }
    try {
      await assertPublicUrl(raw, label);
    } catch (err) {
      if (err instanceof BlockedDestinationError) {
        throw new BadRequestException(
          `${label} points at an internal address. If your identity provider is on an internal address, set SSO_ALLOW_INTERNAL_IDP=true.`
        );
      }
      throw err;
    }
  }

  private allowInternalIdp(): boolean {
    return (process.env.SSO_ALLOW_INTERNAL_IDP || '').toLowerCase() === 'true';
  }

  /**
   * Every request to an identity provider goes through here so the same
   * address policy applies at fetch time as at save time, redirects included.
   */
  fetchIdp(url: string | URL, init: GuardedFetchInit = {}): Promise<Response> {
    return guardedFetch(url, {
      ...init,
      label: 'Identity provider URL',
      allowPrivate: this.allowInternalIdp()
    });
  }

  private iconUrl(raw: string | null | undefined, current: string | null): string | null {
    const value = typeof raw === 'string' ? raw.trim() : null;
    if (!value) return null;
    if (value === current) return value;
    if (value.length > 500) throw new BadRequestException('Icon URL is too long');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Icon URL must be a valid URL');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new BadRequestException('Icon URL must use https');
    }
    return value;
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  private async uniqueSlug(organizationId: string | null, desired: string, ignoreId?: string) {
    const base = this.slugify(desired) || 'sso';
    let candidate = RESERVED_PROVIDER_SLUGS.has(base) ? `${base}-sso` : base;
    let n = 2;

    while (await this.slugTaken(organizationId, candidate, ignoreId)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }

  private async slugTaken(organizationId: string | null, slug: string, ignoreId?: string) {
    const hit = await this.prisma.identityProvider.findFirst({
      where: { organizationId, slug, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true }
    });
    return Boolean(hit);
  }

  /**
   * Turn the admin form into column values. Presets fill in what the admin
   * didn't type; a blank secret means "keep what's stored" so the UI never has
   * to round-trip a client secret it was only ever shown a mask of.
   */
  private async buildProviderData(
    input: ProviderInput,
    existing: IdentityProvider | null,
    organizationId: string | null
  ) {
    const presetId = input.preset ?? existing?.preset ?? 'generic';
    const preset = findPreset(presetId);
    if (!preset) throw new BadRequestException(`Unknown provider preset "${presetId}"`);

    const protocol = input.protocol ?? existing?.protocol ?? preset.protocol;
    const name = (input.name ?? existing?.name ?? preset.name).trim();
    if (!name) throw new BadRequestException('Provider name is required');

    const data: Record<string, unknown> = {
      name,
      preset: presetId,
      protocol,
      enabled: input.enabled ?? existing?.enabled ?? true,
      buttonLabel: input.buttonLabel ?? existing?.buttonLabel ?? null,
      iconUrl:
        'iconUrl' in input
          ? this.iconUrl(input.iconUrl, existing?.iconUrl ?? null)
          : (existing?.iconUrl ?? null),
      sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
      jitProvisioning: input.jitProvisioning ?? existing?.jitProvisioning ?? true,
      defaultRole: this.safeDefaultRole(input.defaultRole ?? existing?.defaultRole),
      allowedDomains: (input.allowedDomains ?? existing?.allowedDomains ?? [])
        .map((d) => d.toLowerCase().trim().replace(/^@/, ''))
        .filter(Boolean),
      requireVerifiedEmail: input.requireVerifiedEmail ?? existing?.requireVerifiedEmail ?? true
    };

    if (protocol === SsoProtocol.saml) {
      let entryPoint = input.samlEntryPoint ?? existing?.samlEntryPoint ?? null;
      let certificate = isMask(input.samlCertificate) ? null : (input.samlCertificate ?? null);
      let idpEntityId = input.samlIdpEntityId ?? existing?.samlIdpEntityId ?? null;
      const metadataUrl = input.samlMetadataUrl ?? existing?.samlMetadataUrl ?? null;

      if (metadataUrl && (!entryPoint || (!certificate && !existing?.samlCertificate))) {
        const parsed = await this.fetchIdpMetadata(metadataUrl);
        entryPoint = entryPoint || parsed.entryPoint;
        certificate = certificate || parsed.certificate;
        idpEntityId = idpEntityId || parsed.entityId;
      }

      if (!entryPoint) {
        throw new BadRequestException('SAML needs a sign-in URL or a metadata URL');
      }
      this.assertSamlEntryPoint(entryPoint);
      if (!idpEntityId?.trim()) {
        throw new BadRequestException(
          'SAML needs the IdP entity ID (Issuer). Provide it or a metadata URL that includes it'
        );
      }
      idpEntityId = idpEntityId.trim();
      const issuer = (input.samlIssuer ?? existing?.samlIssuer ?? null)?.trim() || null;
      if (issuer && issuer !== existing?.samlIssuer) {
        await this.assertSamlIssuerFree(issuer, existing?.id);
      }
      if (!certificate && !existing?.samlCertificate) {
        throw new BadRequestException('SAML needs the IdP signing certificate');
      }

      data.samlEntryPoint = entryPoint;
      data.samlMetadataUrl = metadataUrl;
      data.samlIdpEntityId = idpEntityId;
      data.samlIssuer = issuer;
      if (certificate)
        data.samlCertificate = this.crypto.encrypt(this.normalizeCertificate(certificate));
    } else {
      const issuerUrl =
        resolveIssuerUrl(preset, {
          issuerUrl: input.issuerUrl ?? (input.tenant || input.domain ? null : existing?.issuerUrl),
          tenant: input.tenant,
          domain: input.domain
        }) ??
        existing?.issuerUrl ??
        null;

      const clientId = (input.clientId ?? existing?.clientId ?? '').trim();
      if (!clientId) throw new BadRequestException('Client ID is required');

      if (protocol === SsoProtocol.oidc && !issuerUrl) {
        throw new BadRequestException('Issuer URL is required for OpenID Connect');
      }

      data.issuerUrl = issuerUrl;
      data.clientId = clientId;
      data.scopes = input.scopes ?? existing?.scopes ?? preset.scopes;
      data.authorizationUrl =
        input.authorizationUrl ?? existing?.authorizationUrl ?? preset.authorizationUrl ?? null;
      data.tokenUrl = input.tokenUrl ?? existing?.tokenUrl ?? preset.tokenUrl ?? null;
      data.userinfoUrl = input.userinfoUrl ?? existing?.userinfoUrl ?? preset.userinfoUrl ?? null;

      if (
        protocol === SsoProtocol.oauth2 &&
        !(data.authorizationUrl && data.tokenUrl && data.userinfoUrl)
      ) {
        throw new BadRequestException(
          'OAuth2 providers need authorization, token, and userinfo URLs'
        );
      }

      // Every one of these is fetched server-side (discovery, token exchange,
      // userinfo, connection test), so each is an SSRF primitive if it can
      // point inside the cluster. Checked at write time, where only admins are.
      await this.assertIdpUrl(issuerUrl, 'Issuer URL');
      await this.assertIdpUrl(data.authorizationUrl as string | null, 'Authorization URL');
      await this.assertIdpUrl(data.tokenUrl as string | null, 'Token URL');
      await this.assertIdpUrl(data.userinfoUrl as string | null, 'Userinfo URL');

      if (input.clientSecret && !isMask(input.clientSecret)) {
        data.clientSecret = this.crypto.encrypt(input.clientSecret);
      } else if (!existing?.clientSecret && protocol === SsoProtocol.oidc) {
        // Public clients are legitimate (PKCE, no secret), so this is allowed,
        // but it is worth a log line when an admin probably just forgot.
        this.logger.warn(
          `Identity provider "${name}" saved without a client secret (org ${organizationId ?? 'instance'})`
        );
      }
    }

    return data;
  }

  async createProvider(
    organizationId: string | null,
    input: ProviderInput,
    actor: { userId: string; email?: string }
  ) {
    const data = await this.buildProviderData(input, null, organizationId);
    const slug = await this.uniqueSlug(organizationId, input.slug || (data.name as string));

    const created = await this.prisma.identityProvider.create({
      data: { ...(data as any), organizationId, slug, createdBy: actor.userId }
    });

    void this.audit.log({
      action: 'org.sso.provider.created',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: organizationId ?? undefined,
      targetType: 'sso_provider',
      targetId: created.id,
      targetLabel: created.name,
      metadata: {
        protocol: created.protocol,
        preset: created.preset,
        scope: organizationId ? 'organization' : 'instance'
      }
    });

    return this.adminProvider(created);
  }

  async updateProvider(
    id: string,
    organizationId: string | null,
    input: ProviderInput,
    actor: { userId: string; email?: string }
  ) {
    const existing = await this.requireProvider(id, organizationId);
    const data = await this.buildProviderData(input, existing, organizationId);

    let { slug } = existing;
    if (input.slug && this.slugify(input.slug) !== existing.slug) {
      slug = await this.uniqueSlug(organizationId, input.slug, id);
    }

    const updated = await this.prisma.identityProvider.update({
      where: { id },
      data: { ...(data as any), slug }
    });

    void this.audit.log({
      action: 'org.sso.provider.updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: organizationId ?? undefined,
      targetType: 'sso_provider',
      targetId: updated.id,
      targetLabel: updated.name,
      metadata: { enabled: updated.enabled, protocol: updated.protocol }
    });

    return this.adminProvider(updated);
  }

  async deleteProvider(
    id: string,
    organizationId: string | null,
    actor: { userId: string; email?: string }
  ) {
    const existing = await this.requireProvider(id, organizationId);
    await this.prisma.identityProvider.delete({ where: { id } });
    await this.discardIcon(existing.iconUrl);

    void this.audit.log({
      action: 'org.sso.provider.deleted',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: organizationId ?? undefined,
      targetType: 'sso_provider',
      targetId: id,
      targetLabel: existing.name
    });

    return { success: true };
  }

  async uploadProviderIcon(
    id: string,
    organizationId: string | null,
    file: Express.Multer.File,
    actor: { userId: string; email?: string }
  ) {
    const existing = await this.requireProvider(id, organizationId);
    const iconUrl = await this.storage.uploadImage(file, 'sso-icons');
    const updated = await this.prisma.identityProvider.update({
      where: { id },
      data: { iconUrl }
    });
    await this.discardIcon(existing.iconUrl);

    void this.audit.log({
      action: 'org.sso.provider.icon_updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: organizationId ?? undefined,
      targetType: 'sso_provider',
      targetId: updated.id,
      targetLabel: updated.name,
      metadata: { scope: organizationId ? 'organization' : 'instance' }
    });

    return this.adminProvider(updated);
  }

  async removeProviderIcon(
    id: string,
    organizationId: string | null,
    actor: { userId: string; email?: string }
  ) {
    const existing = await this.requireProvider(id, organizationId);
    const updated = await this.prisma.identityProvider.update({
      where: { id },
      data: { iconUrl: null }
    });
    await this.discardIcon(existing.iconUrl);

    void this.audit.log({
      action: 'org.sso.provider.icon_removed',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: organizationId ?? undefined,
      targetType: 'sso_provider',
      targetId: updated.id,
      targetLabel: updated.name,
      metadata: { scope: organizationId ? 'organization' : 'instance' }
    });

    return this.adminProvider(updated);
  }

  private async discardIcon(url: string | null) {
    if (!url) return;
    try {
      await this.storage.deleteFile(url);
    } catch (err) {
      this.logger.warn(
        `Could not delete provider icon: ${err instanceof Error ? err.message : 'storage error'}`
      );
    }
  }

  async getSettings(organizationId: string) {
    const settings = await this.prisma.orgSsoSettings.findUnique({ where: { organizationId } });
    if (settings) return settings;
    return {
      organizationId,
      platformEnabled: false,
      enabled: false,
      enforced: false,
      loginLogoUrl: null,
      loginPrimaryColor: null,
      loginBgColor: null,
      loginWelcomeText: null,
      loginTagline: null
    };
  }

  async updateSettings(
    organizationId: string,
    input: SettingsInput,
    actor: { userId: string; email?: string; sessionId?: string }
  ) {
    const current = await this.prisma.orgSsoSettings.findUnique({ where: { organizationId } });

    if (input.enabled && !(current?.platformEnabled ?? false)) {
      throw new ConflictException('An instance admin turned off SSO for this organization');
    }

    if (input.enabled) {
      const usable = await this.prisma.identityProvider.count({
        where: { organizationId, enabled: true }
      });
      if (usable === 0) {
        throw new BadRequestException(
          'Add and enable at least one identity provider before turning SSO on'
        );
      }
    }

    // Colors land inside a style attribute on the login page; only a plain
    // hex value survives so nothing else can ride along into the CSS.
    const hexColor = (v: string | null) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

    const data = {
      enabled: input.enabled ?? current?.enabled ?? false,
      enforced: input.enforced ?? current?.enforced ?? false,
      loginLogoUrl: input.loginLogoUrl ?? current?.loginLogoUrl ?? null,
      loginPrimaryColor: hexColor(input.loginPrimaryColor ?? current?.loginPrimaryColor ?? null),
      loginBgColor: hexColor(input.loginBgColor ?? current?.loginBgColor ?? null),
      loginWelcomeText: input.loginWelcomeText ?? current?.loginWelcomeText ?? null,
      loginTagline: input.loginTagline ?? current?.loginTagline ?? null
    };

    const saved = await this.prisma.orgSsoSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data
    });

    let revokedSessions = 0;
    if (saved.enforced && !current?.enforced) {
      const [members, domains] = await Promise.all([
        this.prisma.organizationMember.findMany({
          where: { organizationId },
          select: { userId: true, user: { select: { email: true } } }
        }),
        this.prisma.orgDomain.findMany({
          where: { organizationId, verifiedAt: { not: null } },
          select: { domain: true }
        })
      ]);
      const owned = new Set(domains.map((d) => d.domain.toLowerCase()));
      revokedSessions = await this.sessions.revokeSignInSessions({
        authMethods: ORG_ENFORCEMENT_REVOKES,
        userIds: members
          .filter((m) => owned.has(m.user.email.split('@')[1]?.toLowerCase() ?? ''))
          .map((m) => m.userId),
        exceptSessionId: actor.sessionId
      });
    }

    if (current?.enabled !== saved.enabled || current?.enforced !== saved.enforced) {
      void this.audit.log({
        action: 'org.sso.settings.updated',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        organizationId,
        targetType: 'organization',
        targetId: organizationId,
        metadata: { enabled: saved.enabled, enforced: saved.enforced, revokedSessions }
      });
    }

    return saved;
  }

  private async anyLiveProvider(): Promise<boolean> {
    const instance = await this.getInstanceProviders();
    if (instance.length > 0) return true;
    const orgLive = await this.prisma.identityProvider.count({
      where: {
        enabled: true,
        organization: { ssoSettings: { is: { enabled: true, platformEnabled: true } } }
      }
    });
    return orgLive > 0;
  }

  async getInstanceEnforcement(): Promise<InstanceEnforcement> {
    const [state, providersAvailable] = await Promise.all([
      this.instanceSettings.getSsoEnforcedState(),
      this.anyLiveProvider()
    ]);
    return { ...state, providersAvailable };
  }

  async setInstanceEnforced(
    enabled: boolean,
    actor: { userId: string; email?: string }
  ): Promise<InstanceEnforcement> {
    const before = await this.instanceSettings.getSsoEnforcedState();
    if (enabled && !(await this.anyLiveProvider())) {
      throw new BadRequestException(
        'Add and enable at least one identity provider before requiring single sign-on'
      );
    }

    await this.instanceSettings.setSsoEnforced(enabled);

    let revokedSessions = 0;
    if (enabled && !before.dbValue) {
      revokedSessions = await this.sessions.revokeSignInSessions({
        authMethods: INSTANCE_ENFORCEMENT_REVOKES
      });
    }

    void this.audit.log({
      action: 'admin.sso.enforcement_toggled',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: 'instance',
      targetId: 'sso_enforced',
      metadata: { enabled, revokedSessions }
    });

    return this.getInstanceEnforcement();
  }

  /** Superadmin switch. Turning it off also drops the org's own enable flag. */
  async setPlatformEnabled(
    organizationId: string,
    platformEnabled: boolean,
    actor: { userId: string; email?: string }
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true }
    });
    if (!org) throw new NotFoundException('Organization not found');

    const saved = await this.prisma.orgSsoSettings.upsert({
      where: { organizationId },
      create: { organizationId, platformEnabled, enabled: false },
      update: platformEnabled
        ? { platformEnabled }
        : { platformEnabled, enabled: false, enforced: false }
    });

    void this.audit.log({
      action: 'admin.sso.platform_toggled',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId,
      targetType: 'organization',
      targetId: organizationId,
      metadata: { platformEnabled }
    });

    return saved;
  }

  /** Per-org SSO status for the admin console list. */
  async getPlatformStatuses() {
    // Driven off organizations, not settings rows: SSO is off until an
    // administrator allows it, so most orgs have no settings row at all and
    // listing from that side would hide exactly the orgs waiting to be
    // enabled.
    const orgs = await this.prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        ssoSettings: true,
        _count: { select: { identityProviders: true, domains: true } }
      },
      orderBy: { name: 'asc' }
    });

    return orgs.map((org) => ({
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      platformEnabled: org.ssoSettings?.platformEnabled ?? false,
      enabled: org.ssoSettings?.enabled ?? false,
      enforced: org.ssoSettings?.enforced ?? false,
      providerCount: org._count.identityProviders,
      domainCount: org._count.domains,
      loginUrl: this.orgLoginUrl(org.slug)
    }));
  }

  private assertSamlEntryPoint(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('SAML sign-in URL must be a valid URL');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const plainOk = local || this.allowInternalIdp();
    if (
      raw.length > 500 ||
      url.username ||
      url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && plainOk))
    ) {
      throw new BadRequestException('SAML sign-in URL must be an https URL');
    }
  }

  private async assertSamlIssuerFree(issuer: string, ignoreId?: string) {
    if (issuer.length > 500 || /[\s<>"']/.test(issuer)) {
      throw new BadRequestException('SP entity ID is not valid');
    }
    const taken = await this.prisma.identityProvider.findFirst({
      where: { samlIssuer: issuer, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true }
    });
    if (taken || issuer.startsWith('orchard-sso-')) {
      throw new BadRequestException('That SP entity ID is already in use');
    }
  }

  normalizeCertificate(input: string): string {
    const blocks = [
      ...input.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)
    ];
    const candidates = (blocks.length ? blocks.map((m) => m[1]) : input.split(/[,;]/))
      .map((c) => c.replace(/\s+/g, ''))
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 0 || unique.length > MAX_IDP_CERTIFICATES) {
      throw new BadRequestException(
        `Provide between 1 and ${MAX_IDP_CERTIFICATES} IdP signing certificates`
      );
    }
    for (const base64 of unique) {
      let key;
      try {
        if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) throw new Error('not base64');
        key = new X509Certificate(Buffer.from(base64, 'base64')).publicKey;
      } catch {
        throw new BadRequestException(
          'The IdP signing certificate is not a valid X.509 certificate'
        );
      }
      if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new BadRequestException(
          'The IdP signing certificate needs an RSA key of 2048 bits or more'
        );
      }
      if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ec') {
        throw new BadRequestException('The IdP signing certificate must use an RSA or EC key');
      }
    }
    return unique.join(',');
  }

  /**
   * Pull the sign-in URL and signing certificate out of an IdP metadata
   * document so the admin doesn't have to copy them by hand.
   *
   * Deliberately a scoped text extraction rather than a full XML parse: this
   * runs once at config time on a document the admin pointed us at, and the
   * values it produces are shown back to them before anything authenticates
   * against them. Signature validation of live assertions is node-saml's job.
   */
  private async fetchIdpMetadata(url: string) {
    await this.assertIdpUrl(url, 'Metadata URL');
    let xml: string;
    try {
      const res = await this.fetchIdp(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > METADATA_MAX_BYTES) throw new Error('metadata too large');
      xml = await res.text();
      if (xml.length > METADATA_MAX_BYTES) throw new Error('metadata too large');
    } catch (err) {
      this.logger.warn(
        `IdP metadata fetch failed: ${err instanceof Error ? err.message : 'request failed'}`
      );
      throw new BadRequestException("Couldn't read IdP metadata from that URL");
    }
    return this.parseIdpMetadata(xml);
  }

  parseIdpMetadata(raw: string) {
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
      throw new BadRequestException("That URL isn't SAML IdP metadata");
    }
    const xml = raw.replace(/<!--[\s\S]*?-->/g, '');
    const descriptors = [...xml.matchAll(/<(?:[\w.-]+:)?EntityDescriptor\b([^>]*)>/g)];
    if (descriptors.length > 1) {
      throw new BadRequestException('IdP metadata must describe exactly one entity');
    }
    const entityId = descriptors[0]
      ? (/\bentityID="([^"]+)"/.exec(descriptors[0][1])?.[1] ?? null)
      : null;

    const ssoServices = [...xml.matchAll(/<[^>]*SingleSignOnService[^>]*>/gi)].map((m) => m[0]);
    const pick = (binding: string) =>
      ssoServices.find((tag) => tag.includes(binding))?.match(/Location="([^"]+)"/i)?.[1] ?? null;
    const entryPoint =
      pick('HTTP-Redirect') ??
      pick('HTTP-POST') ??
      ssoServices[0]?.match(/Location="([^"]+)"/i)?.[1] ??
      null;

    const certificates: string[] = [];
    for (const block of xml.matchAll(
      /<[^>]*KeyDescriptor\b([^>]*)>([\s\S]*?)<\/[^>]*KeyDescriptor>/gi
    )) {
      if (!(/use="signing"/i.test(block[1]) || !/\buse=/i.test(block[1]))) continue;
      for (const cert of block[2].matchAll(
        /<[^>]*X509Certificate[^>]*>([\s\S]*?)<\/[^>]*X509Certificate>/gi
      )) {
        const value = cert[1].replace(/\s+/g, '');
        if (value && !certificates.includes(value)) certificates.push(value);
      }
    }
    const certificate = certificates.length
      ? certificates.slice(0, MAX_IDP_CERTIFICATES).join(',')
      : null;

    if (!entryPoint && !certificate) {
      throw new BadRequestException("That URL isn't SAML IdP metadata");
    }
    return { entityId, entryPoint, certificate };
  }

  /** SP metadata for the admin to hand to their IdP. */
  async getSpMetadata(providerId: string): Promise<string> {
    const provider = await this.prisma.identityProvider.findUnique({ where: { id: providerId } });
    if (!provider || provider.protocol !== SsoProtocol.saml) {
      throw new NotFoundException('SAML provider not found');
    }
    return generateServiceProviderMetadata({
      issuer: this.entityId(provider),
      callbackUrl: this.callbackUrl(provider),
      wantAssertionsSigned: true,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
    });
  }
}
