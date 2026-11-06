import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Logger
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { IdentityProvider, OrganizationRole, SsoProtocol } from '@prisma/client';
// openid-client is ESM only. Loading it lazily keeps this file a CommonJS
// module rather than forcing a require() of an ES module at import time.
import type * as OpenIdClient from 'openid-client' with { 'resolution-mode': 'import' };
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthService } from '../auth/oauth.service';
import { SessionsService } from '../auth/sessions.service';
import { sanitizeUsername } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { signupMode } from '../auth/signup-mode';
import { isSessionCookieSecure } from '../auth/cookies';
import { OidcStateStore } from './oidc-state.store';
import { SamlRequestStore } from './saml-request.store';
import { SsoCryptoService } from './sso-crypto.service';
import { SsoService } from './sso.service';
import { OrgDomainsService } from './org-domains.service';
import { SignJWT, jwtVerify } from 'jose';
import {
  SamlRejected,
  extractIdentity,
  precheckSamlResponse,
  sameSecret,
  verifyAssertion
} from './saml-response';

const SAML_CLOCK_SKEW_MS = 60_000;
const SAML_MAX_ASSERTION_AGE_MS = 10 * 60_000;
const SAML_START_TTL = '5m';
const SAML_START_TTL_MS = 5 * 60_000;
const SAML_REPLAY_TTL_MS = 30 * 60_000;

interface SamlRelayRecord {
  providerId: string;
  requestId: string;
  linkedUserId?: string;
  returnTo?: string;
}

interface IdpProfile {
  email: string;
  name: string;
  emailVerified: boolean | undefined;
  subject?: string | null;
}

export interface SsoLoginResult {
  token: string;
  userId: string;
  redirectTo: string;
}

@Injectable()
export class SsoLoginService {
  private readonly logger = new Logger(SsoLoginService.name);

  private openidClient: Promise<typeof OpenIdClient> | null = null;

  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sso: SsoService,
    private readonly crypto: SsoCryptoService,
    private readonly stateStore: OidcStateStore,
    private readonly samlRequests: SamlRequestStore,
    private readonly oauthService: OAuthService,
    private readonly sessionsService: SessionsService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly domains: OrgDomainsService
  ) {
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  private loadOpenIdClient(): Promise<typeof OpenIdClient> {
    this.openidClient ??= import('openid-client');
    return this.openidClient;
  }

  /**
   * Load a provider that is actually allowed to authenticate right now. Both
   * switches are checked here rather than at the edges, so no controller can
   * forget one: the org's own `enabled` and the platform's `platformEnabled`.
   */
  async loadLoginProvider(providerId: string): Promise<IdentityProvider> {
    const provider = await this.prisma.identityProvider.findUnique({ where: { id: providerId } });
    if (!provider || !provider.enabled) {
      throw new NotFoundException('Identity provider not found');
    }
    if (provider.organizationId) {
      const settings = await this.prisma.orgSsoSettings.findUnique({
        where: { organizationId: provider.organizationId }
      });
      if (!settings?.enabled || !settings.platformEnabled) {
        throw new NotFoundException('Identity provider not found');
      }
    }
    return provider;
  }

  /** Legacy shim: the org-scoped callback URLs configured before the rework. */
  async findLegacyProvider(
    organizationId: string,
    protocol: SsoProtocol
  ): Promise<IdentityProvider> {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { organizationId, protocol, enabled: true },
      orderBy: { createdAt: 'asc' }
    });
    if (!provider) throw new NotFoundException('Identity provider not found');
    return this.loadLoginProvider(provider.id);
  }

  async startLogin(
    providerId: string,
    returnTo?: string,
    sessionToken?: string
  ): Promise<{ url: string; startToken: string }> {
    const provider = await this.loadLoginProvider(providerId);
    if (provider.protocol === SsoProtocol.saml) {
      return this.startSaml(provider, returnTo, sessionToken);
    }
    const url =
      provider.protocol === SsoProtocol.oauth2
        ? await this.startOAuth2(provider, returnTo)
        : await this.startOidc(provider, returnTo);
    return { url, startToken: await this.issueStartToken(providerId, url, sessionToken) };
  }

  async issueStartToken(
    providerId: string,
    authorizeUrl: string,
    sessionToken?: string,
    samlRelay?: string
  ): Promise<string> {
    return new SignJWT({
      type: 'sso_start',
      providerId,
      state: new URL(authorizeUrl).searchParams.get('state') ?? undefined,
      samlRelay,
      linkedUserId: await this.signedInUser(sessionToken)
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(samlRelay ? SAML_START_TTL : '10m')
      .sign(this.oauthService.getJwtSecret());
  }

  private async signedInUser(sessionToken?: string): Promise<string | undefined> {
    if (!sessionToken) return undefined;
    try {
      const payload = await this.oauthService.verifySessionToken(sessionToken);
      if (payload.orgScope || !payload.sessionId) return undefined;
      if (!(await this.sessionsService.validateSession(payload.sessionId))) return undefined;
      if (!payload.externalAuthId) return payload.sub;
      const user =
        (await this.prisma.user.findUnique({
          where: { externalAuthId: payload.externalAuthId },
          select: { id: true }
        })) ??
        (await this.prisma.user.findUnique({
          where: { email: payload.email },
          select: { id: true }
        }));
      return user?.id;
    } catch {
      return undefined;
    }
  }

  async readStartToken(
    providerId: string,
    token: string | undefined,
    state?: string
  ): Promise<{ linkedUserId?: string; samlRelay?: string }> {
    if (!token) throw new UnauthorizedException('SSO sign-in was not started in this browser');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.oauthService.getJwtSecret()));
    } catch {
      throw new UnauthorizedException('SSO sign-in was not started in this browser');
    }
    if (
      payload.type !== 'sso_start' ||
      payload.providerId !== providerId ||
      (state !== undefined && payload.state !== state)
    ) {
      throw new UnauthorizedException('SSO sign-in was not started in this browser');
    }
    return {
      linkedUserId: payload.linkedUserId as string | undefined,
      ...(typeof payload.samlRelay === 'string' ? { samlRelay: payload.samlRelay } : {})
    };
  }

  private newState() {
    return randomBytes(32).toString('hex');
  }

  private async startOidc(provider: IdentityProvider, returnTo?: string): Promise<string> {
    const openid = await this.loadOpenIdClient();
    const config = await this.discoverOidc(provider, openid);

    const codeVerifier = openid.randomPKCECodeVerifier();
    const codeChallenge = await openid.calculatePKCECodeChallenge(codeVerifier);
    const nonce = openid.randomNonce();
    const state = this.newState();

    await this.stateStore.set(state, {
      providerId: provider.id,
      orgId: provider.organizationId,
      codeVerifier,
      nonce,
      returnTo
    });

    const url = openid.buildAuthorizationUrl(config, {
      redirect_uri: this.sso.callbackUrl(provider),
      scope: provider.scopes || 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
      state
    });
    return url.href;
  }

  private async startOAuth2(provider: IdentityProvider, returnTo?: string): Promise<string> {
    const state = this.newState();
    await this.stateStore.set(state, {
      providerId: provider.id,
      orgId: provider.organizationId,
      codeVerifier: '',
      returnTo
    });

    const url = new URL(provider.authorizationUrl);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', this.sso.callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes || '');
    url.searchParams.set('state', state);
    return url.href;
  }

  private async startSaml(
    provider: IdentityProvider,
    returnTo: string | undefined,
    sessionToken?: string
  ): Promise<{ url: string; startToken: string }> {
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const relay = randomBytes(24).toString('hex');
    const saml = this.buildSamlClient(provider, requestId);
    const url = await saml.getAuthorizeUrlAsync(relay, undefined, {});
    const startToken = await this.issueStartToken(provider.id, url, sessionToken, relay);
    const record: SamlRelayRecord = {
      providerId: provider.id,
      requestId,
      linkedUserId: await this.signedInUser(sessionToken),
      returnTo: this.plainReturnTo(returnTo)
    };
    if (
      !(await this.samlRequests.put(`relay:${relay}`, JSON.stringify(record), SAML_START_TTL_MS))
    ) {
      throw new Error('SAML relay collision');
    }
    return { url, startToken };
  }

  private plainReturnTo(returnTo: string | undefined): string | undefined {
    return returnTo && returnTo.length <= 512 && /^\/(?![/\\])[^\u0000-\u0020\u007f\\]*$/.test(returnTo)
      ? returnTo
      : undefined;
  }

  private async discoverOidc(provider: IdentityProvider, openid: typeof OpenIdClient) {
    const clientSecret = this.crypto.decryptOrNull(provider.clientSecret);
    return openid.discovery(
      new URL(provider.issuerUrl),
      provider.clientId,
      clientSecret ? { client_secret: clientSecret } : undefined,
      undefined,
      { [openid.customFetch]: (url, init) => this.sso.fetchIdp(url, init as RequestInit) }
    );
  }

  private scopedSamlCache(providerId: string): CacheProvider {
    const scope = (key: string) => `req:${providerId}:${key}`;
    const store = this.samlRequests;
    return {
      saveAsync: (key, value) => store.saveAsync(scope(key), value),
      getAsync: (key) => store.getAsync(scope(key)),
      removeAsync: (key) => store.removeAsync(key ? scope(key) : null)
    };
  }

  private buildSamlClient(provider: IdentityProvider, requestId?: string): SAML {
    const audience = this.sso.entityId(provider);
    const certs = (this.crypto.decryptOrNull(provider.samlCertificate) ?? '')
      .split(',')
      .filter(Boolean);
    return new SAML({
      callbackUrl: this.sso.callbackUrl(provider),
      entryPoint: provider.samlEntryPoint,
      issuer: audience,
      audience,
      ...(provider.samlIdpEntityId ? { idpIssuer: provider.samlIdpEntityId } : {}),
      idpCert: certs,
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: true,
      validateInResponseTo: ValidateInResponseTo.always,
      acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
      maxAssertionAgeMs: SAML_MAX_ASSERTION_AGE_MS,
      requestIdExpirationPeriodMs: SAML_START_TTL_MS,
      signatureAlgorithm: 'sha256',
      cacheProvider: this.scopedSamlCache(provider.id),
      ...(requestId ? { generateUniqueId: () => requestId } : {})
    });
  }

  async handleOidcCallback(
    providerId: string,
    callbackUrl: URL,
    state: string,
    linkedUserId?: string
  ): Promise<SsoLoginResult> {
    const stateData = await this.stateStore.consume(state);
    if (!stateData) throw new BadRequestException('Invalid or expired SSO state');
    if (stateData.providerId !== providerId) {
      throw new BadRequestException('Provider mismatch in SSO state');
    }

    const provider = await this.loadLoginProvider(providerId);
    const openid = await this.loadOpenIdClient();
    const config = await this.discoverOidc(provider, openid);

    const tokens = await openid.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: stateData.codeVerifier,
      expectedState: state,
      expectedNonce: stateData.nonce
    });

    const claims = tokens.claims() as Record<string, unknown>;
    const email = typeof claims.email === 'string' ? claims.email : '';
    if (!email) throw new BadRequestException("SSO provider didn't return an email address");

    return this.completeLogin(
      provider,
      {
        email,
        name: (claims.name as string) || email.split('@')[0],
        emailVerified: claims.email_verified as boolean | undefined,
        subject: (claims.sub as string) ?? null
      },
      stateData.returnTo,
      linkedUserId
    );
  }

  async handleOAuth2Callback(
    providerId: string,
    code: string,
    state: string,
    linkedUserId?: string
  ): Promise<SsoLoginResult> {
    const stateData = await this.stateStore.consume(state);
    if (!stateData) throw new BadRequestException('Invalid or expired SSO state');
    if (stateData.providerId !== providerId) {
      throw new BadRequestException('Provider mismatch in SSO state');
    }

    const provider = await this.loadLoginProvider(providerId);
    const clientSecret = this.crypto.decryptOrNull(provider.clientSecret);

    const tokenRes = await this.sso.fetchIdp(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        redirect_uri: this.sso.callbackUrl(provider),
        grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!tokenRes.ok) throw new UnauthorizedException('SSO token exchange failed');
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) throw new UnauthorizedException('SSO token exchange failed');

    const profile = await this.fetchOAuth2Profile(provider, tokenBody.access_token);
    return this.completeLogin(provider, profile, stateData.returnTo, linkedUserId);
  }

  async handleSamlCallback(
    providerId: string,
    samlResponse: string,
    relayState: string | undefined,
    startToken: string | undefined
  ): Promise<SsoLoginResult> {
    const denied = () => new UnauthorizedException('SSO sign-in was not started in this browser');
    if (typeof relayState !== 'string' || !/^[0-9a-f]{48}$/.test(relayState)) throw denied();

    if (startToken || isSessionCookieSecure()) {
      const start = await this.readStartToken(providerId, startToken);
      if (!start.samlRelay || !sameSecret(start.samlRelay, relayState)) throw denied();
    }
    const raw = await this.samlRequests.take(`relay:${relayState}`);
    if (!raw) throw denied();
    const record = JSON.parse(raw) as SamlRelayRecord;
    if (record.providerId !== providerId) throw denied();

    const provider = await this.loadLoginProvider(providerId);
    if (provider.protocol !== SsoProtocol.saml || !provider.samlIdpEntityId) {
      throw new UnauthorizedException('SSO authentication failed');
    }

    let identity: { email: string; name: string; subject: string };
    try {
      precheckSamlResponse(samlResponse, this.sso.callbackUrl(provider));
      const saml = this.buildSamlClient(provider);
      const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      if (!profile || profile.inResponseTo !== record.requestId) {
        throw new SamlRejected('InResponseTo does not match this browser session');
      }
      const verified = verifyAssertion(profile.getAssertion() as Record<string, any>, {
        acsUrl: this.sso.callbackUrl(provider),
        idpEntityId: provider.samlIdpEntityId,
        audience: this.sso.entityId(provider),
        requestId: record.requestId,
        now: Date.now(),
        skewMs: SAML_CLOCK_SKEW_MS,
        maxAgeMs: SAML_MAX_ASSERTION_AGE_MS
      });
      const claimed = extractIdentity(
        verified,
        (profile.attributes ?? {}) as Record<string, unknown>
      );
      if (!claimed) throw new SamlRejected("SAML provider didn't return a usable email address");
      if (
        !(await this.samlRequests.put(
          `assertion:${providerId}:${createHash('sha256').update(verified.assertionId).digest('hex')}`,
          '1',
          SAML_REPLAY_TTL_MS
        ))
      ) {
        throw new SamlRejected('assertion replayed');
      }
      identity = { ...claimed, subject: verified.nameId };
    } catch (err) {
      this.logger.warn(
        `SAML response rejected for provider ${providerId}: ${err instanceof Error ? err.message : 'error'}`
      );
      throw new UnauthorizedException('SSO authentication failed');
    }

    return this.completeLogin(
      provider,
      {
        email: identity.email,
        name: identity.name,
        emailVerified: true,
        subject: identity.subject
      },
      record.returnTo,
      record.linkedUserId
    );
  }

  /**
   * OAuth2 has no userinfo contract, so each provider needs its own read.
   * GitHub is the case that matters: /user hides the email when the account
   * keeps it private, and only /user/emails knows which address is both
   * primary and verified.
   */
  private async fetchOAuth2Profile(
    provider: IdentityProvider,
    accessToken: string
  ): Promise<IdpProfile> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Orchard'
    };

    const res = await this.sso.fetchIdp(provider.userinfoUrl, {
      headers,
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) throw new UnauthorizedException('Could not read profile from SSO provider');
    const body = (await res.json()) as Record<string, unknown>;

    let email = typeof body.email === 'string' ? body.email : '';
    let emailVerified = typeof body.email_verified === 'boolean' ? body.email_verified : undefined;

    if (provider.preset === 'github') {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers,
        signal: AbortSignal.timeout(15_000)
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as {
          email: string;
          primary: boolean;
          verified: boolean;
        }[];
        const primary =
          emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        if (primary) {
          email = primary.email;
          emailVerified = true;
        }
      }
    }

    if (!email) throw new BadRequestException("SSO provider didn't return an email address");

    const name =
      (typeof body.name === 'string' && body.name) ||
      (typeof body.login === 'string' && body.login) ||
      email.split('@')[0];

    return { email, name, emailVerified, subject: body.id ? String(body.id) : null };
  }

  private async completeLogin(
    provider: IdentityProvider,
    profile: IdpProfile,
    returnTo?: string,
    linkedUserId?: string
  ): Promise<SsoLoginResult> {
    const email = profile.email.toLowerCase().trim();

    // An IdP that omits email_verified is treated as unverified: an attacker
    // who can attach a hostile IdP and pick any subject for it should not get
    // a free pass by simply declining to assert verification.
    if (provider.requireVerifiedEmail && profile.emailVerified !== true) {
      throw new UnauthorizedException('email not verified');
    }
    if (profile.emailVerified === false) {
      throw new UnauthorizedException('email not verified');
    }

    const domains = provider.allowedDomains.length
      ? provider.allowedDomains
      : this.legacyAllowedDomains(provider.organizationId);
    if (domains && domains.length) {
      const domain = email.split('@')[1] || '';
      if (!domains.includes(domain)) {
        throw new UnauthorizedException('Email domain not allowed for this organization');
      }
    }

    const user = provider.organizationId
      ? await this.resolveOrgUser(provider, email, profile.name, linkedUserId)
      : await this.resolveInstanceUser(provider, email, profile.name);

    if (!user.setupCompleted) {
      await this.prisma.user.update({ where: { id: user.id }, data: { setupCompleted: true } });
    }

    await this.prisma.identityProvider.update({
      where: { id: provider.id },
      data: { lastUsedAt: new Date() }
    });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      authMethod: 'sso'
    });
    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      // SSO sessions ride the same token shape as OTP ones.
      'otp',
      sessionId,
      // An org's IdP vouches for the identity inside that org and nowhere
      // else, so the session it produces is confined there. Instance-wide
      // providers are configured by the platform operator and stay unconfined.
      provider.organizationId ?? undefined
    );

    return { token, userId: user.id, redirectTo: this.safeReturnTo(returnTo) };
  }

  private safeReturnTo(returnTo: string | undefined): string {
    if (
      returnTo &&
      returnTo.length <= 512 &&
      /^\/(?![/\\])[^\u0000-\u0020\u007f\\]*$/.test(returnTo)
    ) {
      return `${this.frontendUrl}${returnTo}`;
    }
    return `${this.frontendUrl}/oauth/callback`;
  }

  private legacyAllowedDomains(organizationId: string | null): string[] | null {
    // Pre-rework deployments configured this through an env map. Columns win;
    // this only fills in when the provider has no allowlist of its own.
    if (!organizationId) return null;
    const raw = process.env.SSO_ALLOWED_EMAIL_DOMAINS;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const list = parsed?.[organizationId];
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.map((d: string) => String(d).toLowerCase());
    } catch {
      return null;
    }
  }

  private async createUser(email: string, name: string) {
    const baseUsername = sanitizeUsername(email.split('@')[0]);
    let username = baseUsername;
    let counter = 1;

    while (await this.prisma.user.findUnique({ where: { username } })) {
      username = `${baseUsername}${counter}`;
      counter += 1;
    }
    const parts = name.split(' ');
    return this.prisma.user.create({
      data: {
        email,
        username,
        firstName: parts[0] || null,
        lastName: parts.slice(1).join(' ') || null
      }
    });
  }

  /**
   * Org-scoped sign-in.
   *
   * The rule that matters: an existing platform account is never handed to an
   * org's IdP just because it asserted that email. Whoever controls an IdP can
   * assert any address, so a match on email alone would let one tenant
   * impersonate any user of the platform whose address they know. Access needs
   * a second fact that didn't come from the IdP, and the only one that counts
   * is an existing membership.
   *
   * A pending invitation is NOT that second fact. Any org admin can create one
   * for any address without the recipient ever acting, so treating it as proof
   * would let an admin mint an invite and then walk into the account behind
   * that address. Invitations are accepted by the person holding the emailed
   * token, in their own session: the same rule the direct-add path already
   * refuses to bend.
   */
  private async resolveOrgUser(
    provider: IdentityProvider,
    email: string,
    name: string,
    linkedUserId?: string
  ) {
    const organizationId = provider.organizationId;
    let user = await this.prisma.user.findUnique({ where: { email } });

    if (user) {
      const membership = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.id } }
      });
      if (!membership) {
        // Generic on purpose: telling the caller "that email exists elsewhere"
        // turns this endpoint into a user-enumeration oracle for any tenant.
        throw new UnauthorizedException('SSO authentication failed');
      }
      // A tenant's IdP must never be able to mint a platform-operator session:
      // that would turn "admin of one org" into "admin of the instance".
      if (user.isSuperAdmin) {
        this.logger.warn(
          `Refused org SSO for superadmin ${user.id} via provider ${provider.id} (org ${organizationId})`
        );
        throw new UnauthorizedException('SSO authentication failed');
      }
      if (
        membership.role === OrganizationRole.owner &&
        (!provider.createdBy || provider.createdBy !== user.id)
      ) {
        this.logger.warn(
          `Refused org SSO for owner ${user.id} via provider ${provider.id} (org ${organizationId}): provider wasn't configured by this owner`
        );
        throw new UnauthorizedException('SSO authentication failed');
      }
      // Membership doesn't let an org act as an account it doesn't own: that
      // takes its verified domain, or the person starting this sign-in from
      // their own session.
      // An account whose address Orchard hasn't verified has no owner to
      // consent, so a session of it can't vouch either: only the org's
      // verified domain can claim it.
      const consented = user.emailVerified && linkedUserId === user.id;
      if (
        membership.role !== OrganizationRole.owner &&
        !consented &&
        !(await this.domains.isVerifiedFor(organizationId, email.split('@')[1] || ''))
      ) {
        const organization = await this.prisma.organization.findUnique({
          where: { id: organizationId },
          select: { slug: true }
        });
        throw new UnauthorizedException({
          message: 'sso_link_required',
          orgSlug: organization?.slug
        });
      }
      return user;
    }

    if (!provider.jitProvisioning) {
      throw new UnauthorizedException('SSO authentication failed');
    }

    // Creating an account is claiming an address, so an org may only do it
    // inside a namespace it has proved it owns (DNS TXT, see OrgDomain).
    // Otherwise any tenant admin could point a hostile IdP at
    // ceo@bigcorp.com and pre-create that account before its owner ever
    // signs up. People outside a verified domain join by invitation, where
    // the emailed token proves they hold the mailbox.
    const domain = email.split('@')[1] || '';
    if (!(await this.domains.isVerifiedFor(organizationId, domain))) {
      this.logger.warn(
        `Refused SSO account creation for ${domain} in org ${organizationId}: domain not verified`
      );
      throw new UnauthorizedException('SSO authentication failed');
    }

    user = await this.createUser(email, name);
    void this.audit.log({
      action: 'user.signed_up',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      targetType: 'user',
      targetId: user.id,
      metadata: { signup_method: 'sso', provider: provider.name }
    });

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: { organizationId, email, expiresAt: { gt: new Date() } }
    });
    if (invitation) {
      await this.acceptInvitation(invitation, user.id);
      return user;
    }

    const role = provider.defaultRole ?? OrganizationRole.member;
    await this.prisma.organizationMember.create({
      data: { organizationId, userId: user.id, role }
    });
    // An admin reviewing the member list needs to tell "was invited and joined"
    // apart from "authenticated against the bound IdP and was let in", which
    // is exactly the distinction that matters after an IdP compromise.
    void this.audit.log({
      action: 'org.member.joined',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role, via: 'sso_auto_provision', provider: provider.name }
    });
    return user;
  }

  private async acceptInvitation(
    invitation: {
      id: string;
      organizationId: string;
      role: OrganizationRole;
      projectId: string | null;
      projectRoleId: string | null;
    },
    userId: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
        create: { organizationId: invitation.organizationId, userId, role: invitation.role },
        update: {}
      });
      if (invitation.projectId && invitation.projectRoleId) {
        const existing = await tx.projectMember.findFirst({
          where: { projectId: invitation.projectId, userId }
        });
        if (!existing) {
          await tx.projectMember.create({
            data: { projectId: invitation.projectId, userId, roleId: invitation.projectRoleId }
          });
        }
      }
      await tx.organizationInvitation.delete({ where: { id: invitation.id } });
    });

    void this.audit.log({
      action: 'org.member.joined',
      actorUserId: userId,
      organizationId: invitation.organizationId,
      targetType: 'user',
      targetId: userId,
      metadata: { role: invitation.role, via: 'sso_invitation' }
    });
  }

  /**
   * Instance-wide sign-in. There is no org to join, so the gates are the
   * platform's own: an org that enforces its IdP must not be reachable through
   * the platform's Google button, and signup mode still decides who may create
   * an account.
   */
  private async resolveInstanceUser(provider: IdentityProvider, email: string, name: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      await this.authz.assertSsoNotEnforced(existing, 'instance_sso');
    } else {
      await this.authz.assertSsoNotEnforcedForEmail(email, 'instance_sso');
    }

    if (!(await this.hasSignupAccess(email, existing))) {
      throw new UnauthorizedException(
        signupMode() === 'closed' ? 'signups_disabled' : 'private_beta'
      );
    }

    if (existing) return existing;

    if (!provider.jitProvisioning) {
      throw new UnauthorizedException('SSO authentication failed');
    }

    const user = await this.createUser(email, name);
    void this.audit.log({
      action: 'user.signed_up',
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: 'user',
      targetId: user.id,
      metadata: { signup_method: 'sso', provider: provider.name, scope: 'instance' }
    });
    return user;
  }

  private async hasSignupAccess(
    email: string,
    existingUser: { id: string; isSuperAdmin: boolean } | null
  ): Promise<boolean> {
    if (signupMode() === 'open') return true;
    if (existingUser?.isSuperAdmin) return true;

    if (existingUser) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId: existingUser.id }
      });
      if (membership) return true;
    }

    if (signupMode() === 'closed') return false;

    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: { email, expiresAt: { gt: new Date() } }
    });
    return Boolean(invitation);
  }

  /**
   * Reaches the IdP the same way a real sign-in would, without creating any
   * session. For OIDC that means running discovery for real; for SAML it means
   * building the AuthnRequest the IdP would receive.
   */
  async testProvider(
    providerId: string
  ): Promise<{ success: boolean; error?: string; testLoginUrl?: string }> {
    try {
      const provider = await this.prisma.identityProvider.findUnique({ where: { id: providerId } });
      if (!provider) throw new NotFoundException('Identity provider not found');

      if (provider.protocol === SsoProtocol.saml) {
        const saml = this.buildSamlClient(provider);
        await saml.getAuthorizeUrlAsync('', undefined, {});
      } else if (provider.protocol === SsoProtocol.oidc) {
        const openid = await this.loadOpenIdClient();
        await this.discoverOidc(provider, openid);
      } else {
        const res = await this.sso.fetchIdp(provider.authorizationUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10_000)
        });
        if (res.status >= 500) throw new Error(`Authorization endpoint returned ${res.status}`);
      }

      return { success: true, testLoginUrl: `/apiv1/sso/start/${providerId}` };
    } catch (err) {
      this.logger.warn(`SSO test failed for provider ${providerId}: ${(err as Error).message}`);
      return {
        success: false,
        error: err instanceof Error ? err.message : "Couldn't reach the identity provider"
      };
    }
  }
}
