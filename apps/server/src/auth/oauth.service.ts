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
  hackClubId?: string;
  authMethod?: 'oauth' | 'otp' | 'passkey';
  sessionId?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class OAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly jwtSecret: Uint8Array;

  constructor() {
    this.clientId = process.env.HACKCLUB_CLIENT_ID;
    this.clientSecret = process.env.HACKCLUB_CLIENT_SECRET;
    this.redirectUri = process.env.HACKCLUB_REDIRECT_URI;

    const jwtSecretString = process.env.JWT_SECRET;
    if (!jwtSecretString) {
      throw new Error('JWT_SECRET environment variable is required');
    }

    this.jwtSecret = new TextEncoder().encode(jwtSecretString);

    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('Missing Hack Club OAuth configuration');
    }
  }

  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'email name',
      response_type: 'code',
    });

    if (state) {
      params.append('state', state);
    }

    return `https://account.hackclub.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://account.hackclub.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for token: ${error}`);
    }

    const data = await response.json();
    return data.access_token;
  }

  async getUserInfo(accessToken: string): Promise<HackClubUser> {
    const response = await fetch('https://account.hackclub.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    const data = await response.json();
    const identity = data.identity;

    return {
      id: identity.id,
      email: identity.primary_email,
      name: `${identity.first_name} ${identity.last_name}`,
      slackId: identity.slack_id,
    };
  }

  async generateSessionToken(user: HackClubUser, sessionId?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      email: user.email,
      name: user.name,
      hackClubId: user.id,
      authMethod: 'oauth',
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
   * Generate a session token for users authenticated via OTP or passkey.
   */
  async generateSessionTokenForUser(
    userId: string,
    email: string,
    name: string,
    authMethod: 'otp' | 'passkey',
    sessionId?: string,
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      email,
      name,
      authMethod,
    };
    if (sessionId) payload.sessionId = sessionId;

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.jwtSecret);

    return token;
  }

  /**
   * Get the JWT secret for external services.
   */
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
        hackClubId: payload.hackClubId as string | undefined,
        authMethod: (payload.authMethod as 'oauth' | 'otp' | 'passkey') || 'oauth',
        sessionId: payload.sessionId as string | undefined,
        iat: payload.iat as number,
        exp: payload.exp as number,
      };
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }
}
