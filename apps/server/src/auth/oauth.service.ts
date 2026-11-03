import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';

export interface HackClubUser {
  id: string;
  email: string;
  name: string;
  slackId?: string;
}

export interface TokenPayload {
  sub: string;
  email: string;
  name: string;
  externalAuthId?: string;
  authMethod?: 'oauth' | 'otp' | 'passkey';
  sessionId?: string;
  orgScope?: string;
  iat: number;
  exp: number;
}

export type AuthProvider = 'hackclub' | 'oidc' | 'none';

interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
}

const HACKCLUB_ENDPOINTS: OAuthEndpoints = {
  authorizeUrl: 'https://account.hackclub.com/oauth/authorize',
  tokenUrl: 'https://account.hackclub.com/oauth/token',
  userinfoUrl: 'https://account.hackclub.com/api/v1/me'
};

function claimPath(data: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (obj, key) =>
        obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined,
      data
    );
}

@Injectable()
export class OAuthService {
  private readonly provider: AuthProvider;

  private readonly clientId?: string;

  private readonly clientSecret?: string;

  private readonly redirectUri?: string;

  private readonly scopes: string;

  private readonly jwtSecret: Uint8Array;

  private oidcEndpoints: OAuthEndpoints | null = null;

  constructor() {
    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    if (jwtSecretString.length < 32 || jwtSecretString === 'change-me-to-a-long-random-string') {
      throw new Error(
        'JWT_SECRET must be at least 32 characters and not the example value; every session, cookie and code is signed with it'
      );
    }
    this.jwtSecret = new TextEncoder().encode(jwtSecretString);

    const configured = process.env.AUTH_PROVIDER;
    if (configured === 'hackclub' || configured === 'oidc' || configured === 'none') {
      this.provider = configured;
    } else {
      this.provider = process.env.HACKCLUB_CLIENT_ID ? 'hackclub' : 'none';
    }

    if (this.provider === 'hackclub') {
      this.clientId = process.env.HACKCLUB_CLIENT_ID;
      this.clientSecret = process.env.HACKCLUB_CLIENT_SECRET;
      this.redirectUri = process.env.HACKCLUB_REDIRECT_URI;
      this.scopes = 'email name';
      if (!this.clientId || !this.clientSecret || !this.redirectUri) {
        throw new Error(
          'AUTH_PROVIDER=hackclub requires HACKCLUB_CLIENT_ID, HACKCLUB_CLIENT_SECRET and HACKCLUB_REDIRECT_URI'
        );
      }
    } else if (this.provider === 'oidc') {
      this.clientId = process.env.AUTH_OAUTH_CLIENT_ID;
      this.clientSecret = process.env.AUTH_OAUTH_CLIENT_SECRET;
      this.redirectUri = process.env.AUTH_OAUTH_REDIRECT_URI;
      this.scopes = process.env.AUTH_OAUTH_SCOPES || 'openid email profile';
      const hasExplicitEndpoints =
        process.env.AUTH_OAUTH_AUTHORIZE_URL &&
        process.env.AUTH_OAUTH_TOKEN_URL &&
        process.env.AUTH_OAUTH_USERINFO_URL;
      if (!this.clientId || !this.clientSecret || !this.redirectUri) {
        throw new Error(
          'AUTH_PROVIDER=oidc requires AUTH_OAUTH_CLIENT_ID, AUTH_OAUTH_CLIENT_SECRET and AUTH_OAUTH_REDIRECT_URI'
        );
      }
      if (!process.env.AUTH_OAUTH_ISSUER && !hasExplicitEndpoints) {
        throw new Error(
          'AUTH_PROVIDER=oidc requires AUTH_OAUTH_ISSUER or AUTH_OAUTH_AUTHORIZE_URL + AUTH_OAUTH_TOKEN_URL + AUTH_OAUTH_USERINFO_URL'
        );
      }
    } else {
      this.scopes = '';
    }
  }

  get providerName(): AuthProvider {
    return this.provider;
  }

  get oauthEnabled(): boolean {
    return this.provider !== 'none';
  }

  private async getEndpoints(): Promise<OAuthEndpoints> {
    if (this.provider === 'hackclub') return HACKCLUB_ENDPOINTS;
    if (this.provider === 'none') {
      throw new Error('OAuth login is disabled (AUTH_PROVIDER=none)');
    }
    if (this.oidcEndpoints) return this.oidcEndpoints;

    if (
      process.env.AUTH_OAUTH_AUTHORIZE_URL &&
      process.env.AUTH_OAUTH_TOKEN_URL &&
      process.env.AUTH_OAUTH_USERINFO_URL
    ) {
      this.oidcEndpoints = {
        authorizeUrl: process.env.AUTH_OAUTH_AUTHORIZE_URL,
        tokenUrl: process.env.AUTH_OAUTH_TOKEN_URL,
        userinfoUrl: process.env.AUTH_OAUTH_USERINFO_URL
      };
      return this.oidcEndpoints;
    }

    const issuer = process.env.AUTH_OAUTH_ISSUER!.replace(/\/$/, '');
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed for ${issuer}: ${response.status}`);
    }
    const discovery = await response.json();
    if (
      !discovery.authorization_endpoint ||
      !discovery.token_endpoint ||
      !discovery.userinfo_endpoint
    ) {
      throw new Error(`OIDC discovery document for ${issuer} is missing required endpoints`);
    }
    this.oidcEndpoints = {
      authorizeUrl: discovery.authorization_endpoint,
      tokenUrl: discovery.token_endpoint,
      userinfoUrl: discovery.userinfo_endpoint
    };
    return this.oidcEndpoints;
  }

  async getAuthorizationUrl(state?: string): Promise<string> {
    const endpoints = await this.getEndpoints();
    const params = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri!,
      scope: this.scopes,
      response_type: 'code'
    });

    if (state) {
      params.append('state', state);
    }

    return `${endpoints.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    const endpoints = await this.getEndpoints();
    const params = new URLSearchParams({
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
      redirect_uri: this.redirectUri!,
      code,
      grant_type: 'authorization_code'
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for token: ${error}`);
    }

    const data = await response.json();
    return data.access_token;
  }

  async getUserInfo(accessToken: string): Promise<HackClubUser> {
    const endpoints = await this.getEndpoints();
    const response = await fetch(endpoints.userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    const data = await response.json();

    if (this.provider === 'hackclub') {
      const identity = data.identity;
      return {
        id: identity.id,
        email: identity.primary_email,
        name: `${identity.first_name} ${identity.last_name}`,
        slackId: identity.slack_id
      };
    }

    const id = claimPath(data, process.env.AUTH_OAUTH_CLAIM_ID || 'sub');
    const email = claimPath(data, process.env.AUTH_OAUTH_CLAIM_EMAIL || 'email');
    const name =
      claimPath(data, process.env.AUTH_OAUTH_CLAIM_NAME || 'name') ||
      [claimPath(data, 'given_name'), claimPath(data, 'family_name')].filter(Boolean).join(' ') ||
      claimPath(data, 'preferred_username') ||
      email;

    if (!id || !email) {
      throw new Error('OIDC userinfo response is missing the id or email claim');
    }
    if (claimPath(data, 'email_verified') === false) {
      throw new Error('OIDC provider reports this email as unverified');
    }

    return {
      id: String(id),
      email: String(email),
      name: String(name)
    };
  }

  async generateSessionToken(user: HackClubUser, sessionId?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      email: user.email,
      name: user.name,
      externalAuthId: user.id,
      authMethod: 'oauth'
    };
    if (sessionId) payload.sessionId = sessionId;

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return token;
  }

  /**
   * Generate a session token for users authenticated via OTP, passkey, the
   * superadmin password, or the one-time setup claim that bootstraps an
   * instance with no email transport.
   */
  async generateSessionTokenForUser(
    userId: string,
    email: string,
    name: string,
    authMethod: 'otp' | 'passkey' | 'password' | 'setup_claim',
    sessionId?: string,
    // Confines the session to one organization. Set for sign-ins that came
    // from that org's own identity provider; see RequestAuthContext.
    orgScope?: string
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      email,
      name,
      authMethod
    };
    if (sessionId) payload.sessionId = sessionId;
    if (orgScope) payload.orgScope = orgScope;

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return token;
  }

  getJwtSecret(): Uint8Array {
    return this.jwtSecret;
  }

  async verifySessionToken(token: string): Promise<TokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);

      if (!payload.sub || !payload.email || !payload.name) {
        throw new Error('Invalid token payload');
      }

      return {
        sub: payload.sub as string,
        email: payload.email as string,
        name: payload.name as string,
        externalAuthId: (payload.externalAuthId ?? payload.hackClubId) as string | undefined,
        authMethod: (payload.authMethod as 'oauth' | 'otp' | 'passkey') || 'oauth',
        sessionId: payload.sessionId as string | undefined,
        orgScope: payload.orgScope as string | undefined,
        iat: payload.iat as number,
        exp: payload.exp as number
      };
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }
}
