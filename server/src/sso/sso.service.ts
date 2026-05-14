import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthService } from '../auth/oauth.service';
import { SessionsService } from '../auth/sessions.service';
import { UsersService } from '../users/users.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as openidClient from 'openid-client';
import { SAML } from '@node-saml/node-saml';

const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'mail', 'smtp', 'imap', 'pop', 'ftp',
  'ssh', 'ns1', 'ns2', 'cdn', 'app', 'dashboard', 'login', 'auth',
  'status', 'docs', 'help', 'support', 'billing', 'blog',
]);

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly encryptionKey: Buffer | null;
  private readonly backendUrl: string;
  private readonly baseDomain: string;
  private readonly platformNamespace: string;
  private readonly platformServiceName: string;
  private readonly platformServicePort: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthService: OAuthService,
    private readonly usersService: UsersService,
    private readonly kubernetesService: KubernetesService,
    private readonly sessionsService: SessionsService,
  ) {
    const secret = process.env.SSO_ENCRYPTION_KEY;
    if (secret) {
      this.encryptionKey = scryptSync(secret, 'sso-salt', 32);
    } else {
      this.encryptionKey = null;
    }
    this.backendUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
    this.baseDomain = process.env.BASE_DOMAIN || 'orchard.my';
    this.platformNamespace = process.env.PLATFORM_NAMESPACE || 'default';
    this.platformServiceName = process.env.PLATFORM_SERVICE_NAME || 'leaf-frontend';
    this.platformServicePort = parseInt(process.env.PLATFORM_SERVICE_PORT || '3000', 10);
  }

  // ========== Encryption helpers ==========

  encrypt(plaintext: string): string {
    if (!this.encryptionKey) return plaintext;
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(ciphertext: string): string {
    if (!this.encryptionKey) return ciphertext;
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext; // not encrypted
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  // ========== Subdomain resolution ==========

  async resolveBySubdomain(subdomain: string) {
    const org = await this.prisma.organization.findUnique({
      where: { subdomain },
      include: { ssoConfig: true },
    });

    if (!org) {
      throw new NotFoundException('Organization not found for this subdomain');
    }

    return org;
  }

  async getPublicBranding(subdomain: string) {
    const org = await this.resolveBySubdomain(subdomain);
    const sso = org.ssoConfig;

    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      avatarUrl: org.avatarUrl,
      ssoEnabled: sso?.enabled ?? false,
      ssoEnforced: sso?.enforced ?? false,
      provider: sso?.provider ?? null,
      loginLogoUrl: sso?.loginLogoUrl ?? null,
      loginPrimaryColor: sso?.loginPrimaryColor ?? null,
      loginBgColor: sso?.loginBgColor ?? null,
      loginWelcomeText: sso?.loginWelcomeText ?? null,
    };
  }

  // ========== Subdomain management ==========

  async setSubdomain(organizationId: string, subdomain: string | null) {
    if (subdomain !== null) {
      const normalized = subdomain.toLowerCase().trim();

      if (!/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])?$/.test(normalized)) {
        throw new BadRequestException(
          'Subdomain must be 3-50 characters, alphanumeric and hyphens only, cannot start or end with a hyphen',
        );
      }

      if (RESERVED_SUBDOMAINS.has(normalized)) {
        throw new BadRequestException('This subdomain is reserved');
      }

      // Transactionally re-check uniqueness and write the new subdomain.
      const { result, oldSubdomain } = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.organization.findUnique({
            where: { id: organizationId },
            select: { subdomain: true },
          });
          const oldSubdomain = current?.subdomain ?? null;

          const conflict = await tx.organization.findFirst({
            where: { subdomain: normalized, NOT: { id: organizationId } },
            select: { id: true },
          });
          if (conflict) {
            throw new ConflictException('This subdomain is already taken');
          }

          const result = await tx.organization.update({
            where: { id: organizationId },
            data: { subdomain: normalized },
          });

          return { result, oldSubdomain };
        },
      );

      // Ingress work happens AFTER the DB commit. On failure, compensate by
      // reverting the subdomain back to its previous value.
      try {
        if (oldSubdomain && oldSubdomain !== normalized) {
          await this.deleteSsoIngress(oldSubdomain);
        }
        await this.ensureSsoIngress(normalized);
      } catch (err) {
        this.logger.error(
          `Ingress provisioning failed for subdomain ${normalized}; reverting DB to ${oldSubdomain ?? 'null'}`,
          err instanceof Error ? err.stack : String(err),
        );
        try {
          await this.prisma.organization.update({
            where: { id: organizationId },
            data: { subdomain: oldSubdomain },
          });
        } catch (revertErr) {
          this.logger.error(
            `Failed to revert subdomain after ingress failure for org ${organizationId}`,
            revertErr instanceof Error ? revertErr.stack : String(revertErr),
          );
        }
        throw err;
      }

      return result;
    }

    // Subdomain is being cleared
    const { result, oldSubdomain } = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { subdomain: true },
        });
        const oldSubdomain = current?.subdomain ?? null;

        const result = await tx.organization.update({
          where: { id: organizationId },
          data: { subdomain: null },
        });

        return { result, oldSubdomain };
      },
    );

    if (oldSubdomain) {
      try {
        await this.deleteSsoIngress(oldSubdomain);
      } catch (err) {
        this.logger.error(
          `Failed to delete SSO ingress for ${oldSubdomain}; reverting DB`,
          err instanceof Error ? err.stack : String(err),
        );
        try {
          await this.prisma.organization.update({
            where: { id: organizationId },
            data: { subdomain: oldSubdomain },
          });
        } catch (revertErr) {
          this.logger.error(
            `Failed to revert subdomain clear for org ${organizationId}`,
            revertErr instanceof Error ? revertErr.stack : String(revertErr),
          );
        }
        throw err;
      }
    }

    return result;
  }

  private ssoIngressName(subdomain: string): string {
    return `sso-${subdomain}`.substring(0, 63);
  }

  private async ensureSsoIngress(subdomain: string) {
    const host = `${subdomain}.${this.baseDomain}`;
    const ingressName = this.ssoIngressName(subdomain);
    const tlsSecretName = `sso-tls-${subdomain}`;

    // Let createIngress handle entrypoints + HTTPS redirect middleware
    // automatically via the TLS path (hasTls = true when tlsSecretName is set).
    const ingressOpts = {
      namespace: this.platformNamespace,
      name: ingressName,
      host,
      path: '/',
      pathType: 'Prefix',
      serviceName: this.platformServiceName,
      servicePort: this.platformServicePort,
      tlsSecretName,
      tlsHosts: [host],
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
      },
    };

    try {
      await this.kubernetesService.createIngress(ingressOpts);
      this.logger.log(`Created SSO ingress "${ingressName}" for ${host}`);
    } catch (error) {
      if (error?.response?.error === 'Ingress already exists') {
        try {
          await this.kubernetesService.updateIngress(ingressOpts);
          this.logger.log(`Updated SSO ingress "${ingressName}" for ${host}`);
        } catch (updateErr) {
          this.logger.error(`Failed to update SSO ingress for ${host}:`, updateErr);
        }
      } else {
        this.logger.error(`Failed to create SSO ingress for ${host}:`, error);
      }
    }
  }

  private async deleteSsoIngress(subdomain: string) {
    const ingressName = this.ssoIngressName(subdomain);
    try {
      await this.kubernetesService.deleteIngress(
        this.platformNamespace,
        ingressName,
      );
      this.logger.log(`Deleted SSO ingress "${ingressName}"`);
    } catch (error) {
      // Ignore 404 — ingress may not exist
      this.logger.warn(`Failed to delete SSO ingress "${ingressName}": ${error?.message}`);
    }
  }

  // ========== SSO Config CRUD ==========

  async getSsoConfig(organizationId: string) {
    const config = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
    });

    if (!config) return null;

    // Mask secrets
    return {
      ...config,
      oidcClientSecret: config.oidcClientSecret ? '••••••••' : null,
      samlCertificate: config.samlCertificate ? '(configured)' : null,
    };
  }

  async upsertSsoConfig(organizationId: string, data: {
    provider: 'oidc' | 'saml';
    oidcIssuerUrl?: string;
    oidcClientId?: string;
    oidcClientSecret?: string;
    oidcScopes?: string;
    samlEntryPoint?: string;
    samlIssuer?: string;
    samlCertificate?: string;
    samlMetadataUrl?: string;
    loginLogoUrl?: string;
    loginPrimaryColor?: string;
    loginBgColor?: string;
    loginWelcomeText?: string;
    enabled?: boolean;
    enforced?: boolean;
  }) {
    // Validate based on provider
    if (data.provider === 'oidc') {
      if (!data.oidcIssuerUrl || !data.oidcClientId) {
        throw new BadRequestException('OIDC requires issuer URL and client ID');
      }
    } else if (data.provider === 'saml') {
      if (!data.samlEntryPoint && !data.samlMetadataUrl) {
        throw new BadRequestException('SAML requires either an entry point URL or metadata URL');
      }
    } else {
      throw new BadRequestException('Provider must be "oidc" or "saml"');
    }

    // Encrypt secrets
    const configData: any = {
      provider: data.provider,
      oidcIssuerUrl: data.oidcIssuerUrl ?? null,
      oidcClientId: data.oidcClientId ?? null,
      oidcClientSecret: data.oidcClientSecret ? this.encrypt(data.oidcClientSecret) : null,
      oidcScopes: data.oidcScopes ?? 'openid email profile',
      samlEntryPoint: data.samlEntryPoint ?? null,
      samlIssuer: data.samlIssuer ?? null,
      samlCertificate: data.samlCertificate ? this.encrypt(data.samlCertificate) : null,
      samlMetadataUrl: data.samlMetadataUrl ?? null,
      loginLogoUrl: data.loginLogoUrl ?? null,
      loginPrimaryColor: data.loginPrimaryColor ?? null,
      loginBgColor: data.loginBgColor ?? null,
      loginWelcomeText: data.loginWelcomeText ?? null,
      enabled: data.enabled ?? false,
      enforced: data.enforced ?? false,
    };

    return this.prisma.ssoConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        ...configData,
      },
      update: configData,
    });
  }

  async deleteSsoConfig(organizationId: string) {
    const existing = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
    });

    if (!existing) {
      throw new NotFoundException('SSO config not found');
    }

    return this.prisma.ssoConfig.delete({
      where: { organizationId },
    });
  }

  // ========== OIDC Flow ==========

  async initiateOidcLogin(organizationId: string): Promise<string> {
    const config = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
    });

    if (!config || config.provider !== 'oidc' || !config.enabled) {
      throw new BadRequestException('OIDC SSO is not configured or enabled for this organization');
    }

    const issuerUrl = config.oidcIssuerUrl;
    const clientId = config.oidcClientId;
    const clientSecret = config.oidcClientSecret ? this.decrypt(config.oidcClientSecret) : undefined;

    const oidcConfig = await openidClient.discovery(
      new URL(issuerUrl),
      clientId,
      clientSecret ? { client_secret: clientSecret } : undefined,
    );

    const redirectUri = `${this.backendUrl}/apiv1/sso/${organizationId}/callback/oidc`;
    const scopes = config.oidcScopes || 'openid email profile';

    const codeVerifier = openidClient.randomPKCECodeVerifier();
    const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);

    const state = Buffer.from(JSON.stringify({
      orgId: organizationId,
      codeVerifier,
      ts: Date.now(),
    })).toString('base64url');

    const parameters: Record<string, string> = {
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    };

    const authUrl = openidClient.buildAuthorizationUrl(oidcConfig, parameters);
    return authUrl.href;
  }

  async handleOidcCallback(organizationId: string, callbackUrl: URL, state: string) {
    const config = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
      include: { organization: true },
    });

    if (!config || config.provider !== 'oidc') {
      throw new BadRequestException('OIDC SSO is not configured for this organization');
    }

    // Decode state to get code verifier
    let stateData: any;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    } catch {
      throw new BadRequestException('Invalid SSO state');
    }

    if (stateData.orgId !== organizationId) {
      throw new BadRequestException('Organization mismatch in SSO state');
    }

    // Check state is not too old (10 minutes)
    if (Date.now() - stateData.ts > 10 * 60 * 1000) {
      throw new BadRequestException('SSO state has expired');
    }

    const clientId = config.oidcClientId;
    const clientSecret = config.oidcClientSecret ? this.decrypt(config.oidcClientSecret) : undefined;

    const oidcConfig = await openidClient.discovery(
      new URL(config.oidcIssuerUrl),
      clientId,
      clientSecret ? { client_secret: clientSecret } : undefined,
    );

    const redirectUri = `${this.backendUrl}/apiv1/sso/${organizationId}/callback/oidc`;

    const tokens = await openidClient.authorizationCodeGrant(oidcConfig, callbackUrl, {
      pkceCodeVerifier: stateData.codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims();
    const email = claims.email as string;
    const name = (claims.name as string) || email.split('@')[0];

    if (!email) {
      throw new BadRequestException('SSO provider did not return an email address');
    }

    // Resolve user and ensure org membership
    return this.resolveAndAuthenticateUser(organizationId, email, name, config.organization);
  }

  // ========== SAML Flow ==========

  async initiateSamlLogin(organizationId: string): Promise<string> {
    const config = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
    });

    if (!config || config.provider !== 'saml' || !config.enabled) {
      throw new BadRequestException('SAML SSO is not configured or enabled for this organization');
    }

    const saml = this.buildSamlClient(config, organizationId);
    const loginUrl = await saml.getAuthorizeUrlAsync(
      `${this.backendUrl}/apiv1/sso/${organizationId}/callback/saml`,
      {},
      {},
    );

    return loginUrl;
  }

  async handleSamlCallback(organizationId: string, samlResponse: string) {
    const config = await this.prisma.ssoConfig.findUnique({
      where: { organizationId },
      include: { organization: true },
    });

    if (!config || config.provider !== 'saml') {
      throw new BadRequestException('SAML SSO is not configured for this organization');
    }

    const saml = this.buildSamlClient(config, organizationId);
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });

    if (!profile) {
      throw new BadRequestException('SAML response validation failed');
    }

    const email = profile.nameID || (profile as any).email;
    const name = ((profile as any).firstName || '') + ' ' + ((profile as any).lastName || '') || email;

    if (!email) {
      throw new BadRequestException('SAML provider did not return an email address');
    }

    return this.resolveAndAuthenticateUser(organizationId, email, name.trim(), config.organization);
  }

  private buildSamlClient(config: any, organizationId: string): SAML {
    return new SAML({
      callbackUrl: `${this.backendUrl}/apiv1/sso/${organizationId}/callback/saml`,
      entryPoint: config.samlEntryPoint,
      issuer: config.samlIssuer || `orchard-sso-${organizationId}`,
      cert: config.samlCertificate ? this.decrypt(config.samlCertificate) : '',
      wantAuthnResponseSigned: true,
    });
  }

  // ========== Shared user resolution ==========

  private async resolveAndAuthenticateUser(
    organizationId: string,
    email: string,
    name: string,
    organization: any,
  ) {
    const normalizedEmail = email.toLowerCase().trim();

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      const baseUsername = normalizedEmail.split('@')[0];
      let username = baseUsername;
      let counter = 1;
      while (await this.prisma.user.findUnique({ where: { username } })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }

      const nameParts = name.split(' ');
      user = await this.prisma.user.create({
        data: {
          email: normalizedEmail,
          username,
          firstName: nameParts[0] || null,
          lastName: nameParts.slice(1).join(' ') || null,
        },
      });
    }

    // Ensure user is a member of the organization (auto-provision)
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership) {
      await this.prisma.organizationMember.create({
        data: {
          organizationId,
          userId: user.id,
          role: 'member',
        },
      });
    }

    // Mark setup as completed for SSO users
    if (!user.setupCompleted) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { setupCompleted: true },
      });
    }

    // Generate session token
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
      : user.username;

    // Create a tracked session so the resulting JWT is revocable (H6).
    const sessionId = await this.sessionsService.createSession({
      userId: user.id,
      authMethod: 'sso',
    });
    const token = await this.oauthService.generateSessionTokenForUser(
      user.id,
      user.email,
      displayName,
      'otp', // reuse 'otp' auth method type for SSO sessions
      sessionId,
    );

    return {
      token,
      user,
      organizationSlug: organization.slug,
    };
  }
}
