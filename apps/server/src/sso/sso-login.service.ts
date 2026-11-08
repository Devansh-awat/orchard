import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  NotFoundException,
  Logger
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { IdentityProvider, OrganizationRole, SsoProtocol, User } from '@prisma/client';
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
import { assertSafeSamlResponse } from './saml-guard';
import { SsoCryptoService } from './sso-crypto.service';
import { SsoService } from './sso.service';
import { OrgDomainsService } from './org-domains.service';
import { IdentityMappingService, MappingContext, cleanSubject } from './identity-mapping.service';
import { OrgIdentityService } from './org-identity.service';
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import {
  SamlRejected,
  extractIdentity,
  precheckSamlResponse,
  sameSecret,
  verifyAssertion
} from './saml-response';
import { accountEmail } from '../users/account-scope';

const SAML_CLOCK_SKEW_MS = 60_000;
const SAML_MAX_ASSERTION_AGE_MS = 10 * 60_000;
const SAML_START_TTL = '5m';
const SAML_START_TTL_MS = 5 * 60_000;
const SAML_REPLAY_TTL_MS = 30 * 60_000;

interface SamlRelayRecord {
  providerId: string;
  requestId: string;
  linkedUserId?: string;
  linkedSessionId?: string;
  returnTo?: string;
}

interface IdpProfile {
  email: string;
  name: string;
  emailVerified: boolean | undefined;
  subject?: string | null;
  claims?: Record<string, unknown> | null;
}

export interface SsoLoginResult {
  token?: string;
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
    private readonly domains: OrgDomainsService,
    private readonly mapping: IdentityMappingService,
    private readonly identities: OrgIdentityService
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
    const loaded = await this.loadLoginProvider(providerId);
    if (loaded.protocol === SsoProtocol.saml) {
      const provider = await this.sso.ensureIdpEntityId(loaded);
      return this.startSaml(provider, returnTo, sessionToken);
    }
    const provider = loaded;
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
    const linked = await this.signedInUser(sessionToken);
    return new SignJWT({
      type: 'sso_start',
      providerId,
      state: new URL(authorizeUrl).searchParams.get('state') ?? undefined,
      samlRelay,
      linkedUserId: linked?.userId,
      linkedSessionId: linked?.sessionId
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(samlRelay ? SAML_START_TTL : '10m')
      .sign(this.oauthService.getJwtSecret());
  }

  private async signedInUser(
    sessionToken?: string
  ): Promise<{ userId: string; sessionId: string } | undefined> {
    if (!sessionToken) return undefined;
    try {
      const payload = await this.oauthService.verifySessionToken(sessionToken);
      if (payload.orgScope || !payload.sessionId) return undefined;
      if (!(await this.sessionsService.validateSession(payload.sessionId))) return undefined;
      const sessionId = payload.sessionId;
      if (!payload.externalAuthId) return { userId: payload.sub, sessionId };
      const user =
        (await this.prisma.user.findUnique({
          where: { externalAuthId: payload.externalAuthId },
          select: { id: true }
        })) ??
        (await this.prisma.user.findUnique({
          where: accountEmail(payload.email),
          select: { id: true }
        }));
      return user ? { userId: user.id, sessionId } : undefined;
    } catch {
      return undefined;
    }
  }

  async readStartToken(
    providerId: string,
    token: string | undefined,
    state?: string
  ): Promise<{ linkedUserId?: string; linkedSessionId?: string; samlRelay?: string }> {
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
      linkedSessionId: payload.linkedSessionId as string | undefined,
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
    const url = await saml.getAuthorizeUrlAsync(relay, {});
    const startToken = await this.issueStartToken(provider.id, url, sessionToken, relay);
    const linked = await this.signedInUser(sessionToken);
    const record: SamlRelayRecord = {
      providerId: provider.id,
      requestId,
      linkedUserId: linked?.userId,
      linkedSessionId: linked?.sessionId,
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
    return returnTo &&
      returnTo.length <= 512 &&
      // oxlint-disable-next-line no-control-regex
      /^\/(?![/\\])[^\u0000-\u0020\u007f\\]*$/.test(returnTo)
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
      {
        [openid.customFetch]: (url, init) =>
          this.sso.fetchIdp(url, init as RequestInit, provider.organizationId)
      }
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
    linkedUserId?: string,
    linkedSessionId?: string
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

    if (!tokens.id_token) throw new UnauthorizedException('SSO authentication failed');
    await this.verifyIdTokenSignature(provider, config, tokens.id_token);
    const claims = tokens.claims() as Record<string, unknown>;
    const email = typeof claims.email === 'string' ? claims.email : '';
    if (!email) throw new BadRequestException("SSO provider didn't return an email address");

    return this.completeLogin(
      provider,
      {
        email,
        name: (claims.name as string) || email.split('@')[0],
        emailVerified: claims.email_verified as boolean | undefined,
        subject: (claims.sub as string) ?? null,
        claims
      },
      stateData.returnTo,
      linkedUserId,
      linkedSessionId
    );
  }

  private async verifyIdTokenSignature(
    provider: IdentityProvider,
    config: Awaited<ReturnType<SsoLoginService['discoverOidc']>>,
    idToken: string
  ): Promise<void> {
    const header = decodeProtectedHeader(idToken);
    if (typeof header.alg !== 'string' || header.alg.startsWith('HS')) return;
    const metadata = config.serverMetadata();
    if (!metadata.jwks_uri) throw new UnauthorizedException('SSO authentication failed');
    try {
      const res = await this.sso.fetchIdp(
        metadata.jwks_uri,
        { signal: AbortSignal.timeout(15_000) },
        provider.organizationId
      );
      if (!res.ok) throw new Error(`jwks ${res.status}`);
      const jwks = createLocalJWKSet((await res.json()) as Parameters<typeof createLocalJWKSet>[0]);
      await jwtVerify(idToken, jwks, {
        issuer: metadata.issuer,
        audience: provider.clientId,
        algorithms: [
          'RS256',
          'RS384',
          'RS512',
          'PS256',
          'PS384',
          'PS512',
          'ES256',
          'ES384',
          'ES512',
          'EdDSA'
        ]
      });
    } catch (err) {
      this.logger.warn(
        `ID token from provider ${provider.id} failed verification: ${err instanceof Error ? err.message : 'error'}`
      );
      throw new UnauthorizedException('SSO authentication failed');
    }
  }

  async handleOAuth2Callback(
    providerId: string,
    code: string,
    state: string,
    linkedUserId?: string,
    linkedSessionId?: string
  ): Promise<SsoLoginResult> {
    const stateData = await this.stateStore.consume(state);
    if (!stateData) throw new BadRequestException('Invalid or expired SSO state');
    if (stateData.providerId !== providerId) {
      throw new BadRequestException('Provider mismatch in SSO state');
    }

    const provider = await this.loadLoginProvider(providerId);
    const clientSecret = this.crypto.decryptOrNull(provider.clientSecret);

    const tokenRes = await this.sso.fetchIdp(
      provider.tokenUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams({
          client_id: provider.clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          code,
          redirect_uri: this.sso.callbackUrl(provider),
          grant_type: 'authorization_code'
        }),
        signal: AbortSignal.timeout(15_000)
      },
      provider.organizationId
    );
    if (!tokenRes.ok) throw new UnauthorizedException('SSO token exchange failed');
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) throw new UnauthorizedException('SSO token exchange failed');

    const profile = await this.fetchOAuth2Profile(provider, tokenBody.access_token);
    return this.completeLogin(provider, profile, stateData.returnTo, linkedUserId, linkedSessionId);
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

    const loaded = await this.loadLoginProvider(providerId);
    if (loaded.protocol !== SsoProtocol.saml) {
      throw new UnauthorizedException('SSO authentication failed');
    }
    const provider = await this.sso.ensureIdpEntityId(loaded).catch(() => loaded);
    if (!provider.samlIdpEntityId) {
      throw new UnauthorizedException('SSO authentication failed');
    }

    let identity: { email: string; name: string; subject: string };
    let attributes: Record<string, unknown> = {};
    try {
      const safeResponse = assertSafeSamlResponse(samlResponse);
      precheckSamlResponse(safeResponse, this.sso.callbackUrl(provider));
      const saml = this.buildSamlClient(provider);
      const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: safeResponse });
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
      attributes = (profile.attributes ?? {}) as Record<string, unknown>;
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
        emailVerified: provider.organizationId || provider.trustEmail ? true : undefined,
        subject: identity.subject,
        claims: attributes
      },
      record.returnTo,
      record.linkedUserId,
      record.linkedSessionId
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

    const res = await this.sso.fetchIdp(
      provider.userinfoUrl,
      { headers, signal: AbortSignal.timeout(15_000) },
      provider.organizationId
    );
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
    linkedUserId?: string,
    linkedSessionId?: string
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

    const subject = cleanSubject(profile.subject);
    const bound = await this.mapping.findBound(provider, subject);

    if (provider.organizationId) {
      return this.completeOrgLogin(provider, profile, email, subject, bound, {
        returnTo,
        linkedUserId,
        linkedSessionId
      });
    }

    if (bound?.homeOrganizationId) {
      throw new UnauthorizedException('SSO authentication failed');
    }
    const candidate =
      bound ??
      (await this.prisma.user.findUnique({ where: accountEmail(email), select: { id: true } }));
    const mapping = await this.mapping.prepare(provider, profile.claims ?? null, candidate?.id);

    const user = await this.resolveInstanceUser(
      provider,
      email,
      profile.name,
      bound,
      mapping,
      profile.emailVerified === true,
      linkedUserId
    );
    if (user.disabledAt) throw new UnauthorizedException('sso_access_disabled');

    await this.mapping.bind(provider, subject, user);
    const elevated = await this.mapping.syncSuperadmin(
      provider,
      { id: user.id, email: user.email, isSuperAdmin: Boolean(user.isSuperAdmin) },
      mapping,
      profile.emailVerified === true
    );
    await this.mapping.materialize(provider, mapping);
    if (!elevated || mapping.hasRules) await this.mapping.apply(provider, user, mapping);

    return this.issueSession(provider, user as User, returnTo, undefined);
  }

  /**
   * An organization's IdP signs in the organization's own people (org
   * identities) and nobody else. It never resolves an account by email.
   *
   * An account reaches the org through its IdP only when it is already bound
   * to this provider (the person linked it from their own session) and either
   * the person is signing in from that session now, which grants the session
   * entry without minting a new one, or the account's address is on a domain
   * this org has verified, which means the org holds the mailbox anyway.
   * Owners and superadmins always need their own session.
   */
  private async completeOrgLogin(
    provider: IdentityProvider,
    profile: IdpProfile,
    email: string,
    subject: string | null,
    bound: Awaited<ReturnType<IdentityMappingService['findBound']>>,
    ctx: { returnTo?: string; linkedUserId?: string; linkedSessionId?: string }
  ): Promise<SsoLoginResult> {
    const organizationId = provider.organizationId!;
    const denied = () => new UnauthorizedException('SSO authentication failed');
    const settings = await this.prisma.orgSsoSettings.findUnique({
      where: { organizationId },
      select: { maxSessionHours: true, scimOnlySignIn: true }
    });
    const ttlMs = this.orgSessionTtlMs(settings?.maxSessionHours);
    const linked =
      ctx.linkedUserId && ctx.linkedSessionId
        ? await this.prisma.user.findUnique({ where: { id: ctx.linkedUserId } })
        : null;
    const account = linked && !linked.homeOrganizationId ? linked : null;

    let user = bound;
    let mode: 'identity' | 'account' | 'grant';
    let createLink = false;

    if (bound?.homeOrganizationId) {
      if (bound.homeOrganizationId !== organizationId) throw denied();
      mode = 'identity';
    } else if (bound) {
      const member = await this.activeMember(organizationId, bound.id);
      if (bound.isSuperAdmin || !member) throw denied();
      if (account?.id === bound.id) {
        mode = 'grant';
      } else if (
        member.role !== OrganizationRole.owner &&
        bound.emailVerified &&
        (await this.domains.isVerifiedFor(organizationId, bound.email.split('@')[1] || ''))
      ) {
        mode = 'account';
      } else {
        throw await this.signInFirst(organizationId);
      }
    } else if (account && (await this.activeMember(organizationId, account.id))) {
      if (account.isSuperAdmin) throw denied();
      user = account;
      mode = 'grant';
    } else {
      user = await this.identities.findByEmail(organizationId, email);
      if (!user && settings?.scimOnlySignIn) throw denied();
      if (!user && !provider.jitProvisioning) throw denied();
      createLink = Boolean(account);
      mode = 'identity';
    }

    const mapping = await this.mapping.prepare(provider, profile.claims ?? null, user?.id);
    if (mapping.hasRules && !mapping.allowed) {
      const role = user ? (await this.activeMember(organizationId, user.id))?.role : undefined;
      if (role !== OrganizationRole.owner) {
        await this.mapping.deny(provider, mapping, { email, userId: user?.id });
      }
    }

    if (!user) {
      user = await this.identities
        .create(
          organizationId,
          {
            email,
            name: profile.name,
            role: this.jitRole(provider, mapping, organizationId),
            source: 'sso'
          },
          provider.name
        )
        .catch((err) => {
          if (err instanceof ForbiddenException) {
            throw new UnauthorizedException('sso_member_limit');
          }
          throw err;
        });
    }

    if (user.disabledAt) throw new UnauthorizedException('sso_access_disabled');
    if (mode === 'identity') {
      const member = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.id } },
        select: { status: true }
      });
      if (!member) throw denied();
      if (member.status === 'disabled') throw new UnauthorizedException('sso_access_disabled');
    }

    await this.mapping.bind(provider, subject, user);
    await this.mapping.apply(provider, user, mapping);
    if (createLink && account) await this.linkIdentity(account.id, user.id, organizationId);

    if (mode === 'grant') {
      if (!(await this.sessionsService.validateSession(ctx.linkedSessionId!))) throw denied();
      await this.prisma.sessionOrgGrant.upsert({
        where: {
          sessionId_organizationId: { sessionId: ctx.linkedSessionId!, organizationId }
        },
        create: {
          sessionId: ctx.linkedSessionId!,
          organizationId,
          providerId: provider.id,
          expiresAt: new Date(Date.now() + ttlMs)
        },
        update: { providerId: provider.id, expiresAt: new Date(Date.now() + ttlMs) }
      });
      await this.touchProvider(provider);
      void this.audit.log({
        action: 'sso.session.granted',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId,
        targetType: 'identity_provider',
        targetId: provider.id,
        targetLabel: provider.name
      });
      return { userId: user.id, redirectTo: this.safeReturnTo(ctx.returnTo) };
    }

    return this.issueSession(provider, user, ctx.returnTo, ttlMs);
  }

  private orgSessionTtlMs(hours: number | null | undefined): number {
    const h = Number.isInteger(hours) && hours! > 0 ? Math.min(hours!, 24 * 30) : 12;
    return h * 60 * 60_000;
  }

  private jitRole(
    provider: IdentityProvider,
    mapping: MappingContext,
    organizationId: string
  ): OrganizationRole {
    const decided = mapping.decisions.get(organizationId)?.role as OrganizationRole | undefined;
    const role = decided ?? provider.defaultRole ?? OrganizationRole.member;
    return role === OrganizationRole.owner ? OrganizationRole.member : role;
  }

  private activeMember(organizationId: string, userId: string) {
    return this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: 'active' },
      select: { role: true }
    });
  }

  private async signInFirst(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true }
    });
    return new UnauthorizedException({ message: 'sso_sign_in_first', orgSlug: organization?.slug });
  }

  private async linkIdentity(
    accountUserId: string,
    identityUserId: string,
    organizationId: string
  ) {
    const existing = await this.prisma.accountLink.findUnique({
      where: { accountUserId_organizationId: { accountUserId, organizationId } }
    });
    if (existing) return;
    try {
      await this.prisma.accountLink.create({
        data: { accountUserId, identityUserId, organizationId }
      });
      void this.audit.log({
        action: 'account.link.created',
        actorUserId: accountUserId,
        organizationId,
        targetType: 'user',
        targetId: identityUserId
      });
    } catch (err) {
      this.logger.warn(
        `Could not link identity ${identityUserId} to account ${accountUserId}: ${err instanceof Error ? err.message : 'error'}`
      );
    }
  }

  private async touchProvider(provider: IdentityProvider) {
    await this.prisma.identityProvider.update({
      where: { id: provider.id },
      data: { lastUsedAt: new Date() }
    });
  }

  private async issueSession(
    provider: IdentityProvider,
    user: User,
    returnTo: string | undefined,
    ttlMs: number | undefined
  ): Promise<SsoLoginResult> {
    const orgScope = provider.organizationId ?? undefined;
    if (user.homeOrganizationId && user.homeOrganizationId !== orgScope) {
      throw new UnauthorizedException('SSO authentication failed');
    }
    if (!user.setupCompleted) {
      await this.prisma.user.update({ where: { id: user.id }, data: { setupCompleted: true } });
    }
    await this.touchProvider(provider);

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;
    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      authMethod: 'sso',
      ...(ttlMs ? { ttlMs } : {})
    });
    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'otp',
      sessionId,
      orgScope
    );
    return { token, userId: user.id, redirectTo: this.safeReturnTo(returnTo) };
  }

  private safeReturnTo(returnTo: string | undefined): string {
    if (
      returnTo &&
      returnTo.length <= 512 &&
      // oxlint-disable-next-line no-control-regex
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
   * Instance-wide sign-in. There is no org to join, so the gates are the
   * platform's own: an org that enforces its IdP must not be reachable through
   * the platform's Google button, and signup mode still decides who may create
   * an account.
   */
  private async resolveInstanceUser(
    provider: IdentityProvider,
    email: string,
    name: string,
    bound?: { id: string; email: string; isSuperAdmin: boolean; [key: string]: any } | null,
    mapping?: MappingContext,
    emailVerified = false,
    linkedUserId?: string
  ) {
    const existing = bound ?? (await this.prisma.user.findUnique({ where: accountEmail(email) }));

    if (existing && !bound && !emailVerified && linkedUserId !== existing.id) {
      throw new UnauthorizedException({ message: 'sso_link_required' });
    }

    if (existing) {
      await this.authz.assertSsoNotEnforced(existing, 'instance_sso');
    } else {
      await this.authz.assertSsoNotEnforcedForEmail(email, 'instance_sso');
    }

    if (mapping?.hasRules && !mapping.allowed && !existing?.isSuperAdmin) {
      await this.mapping.deny(provider, mapping, { email, userId: existing?.id });
    }

    if (!(await this.hasSignupAccess(email, existing, Boolean(mapping?.hasRules)))) {
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
    existingUser: { id: string; isSuperAdmin: boolean } | null,
    ruleGranted = false
  ): Promise<boolean> {
    if (signupMode() === 'open' || ruleGranted) return true;
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
        await saml.getAuthorizeUrlAsync('', {});
      } else if (provider.protocol === SsoProtocol.oidc) {
        const openid = await this.loadOpenIdClient();
        await this.discoverOidc(provider, openid);
      } else {
        const res = await this.sso.fetchIdp(
          provider.authorizationUrl,
          { method: 'HEAD', signal: AbortSignal.timeout(10_000) },
          provider.organizationId
        );
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
