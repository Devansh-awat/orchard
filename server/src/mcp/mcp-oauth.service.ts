import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  name: string;
}

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  orchardToken: string;
  expiresAt: number;
}

@Injectable()
export class McpOAuthService {
  private readonly oauthClients = new Map<string, OAuthClient>();
  private readonly authCodes = new Map<string, AuthCodeEntry>();

  private get baseUrl(): string {
    return process.env.MCP_BASE_URL || 'http://localhost:3100';
  }

  private get hackClubClientId(): string {
    return process.env.HACKCLUB_CLIENT_ID!;
  }

  private get hackClubClientSecret(): string {
    return process.env.HACKCLUB_CLIENT_SECRET!;
  }

  private getJwtSecret(): Uint8Array {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required');
    return new TextEncoder().encode(secret);
  }

  get resourceMetadataUrl(): string {
    return `${this.baseUrl}/.well-known/oauth-protected-resource`;
  }

  getProtectedResourceMetadata() {
    return {
      resource: this.baseUrl,
      authorization_servers: [this.baseUrl],
      scopes_supported: ['mcp:access'],
      bearer_methods_supported: ['header'],
    };
  }

  getAuthorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      registration_endpoint: `${this.baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:access'],
    };
  }

  registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }) {
    const clientId = `mcp_${randomBytes(16).toString('hex')}`;
    const clientSecret =
      body.token_endpoint_auth_method === 'client_secret_post'
        ? randomBytes(32).toString('hex')
        : undefined;

    this.oauthClients.set(clientId, {
      clientId,
      clientSecret,
      redirectUris: body.redirect_uris || [],
      name: body.client_name || 'MCP Client',
    });

    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
    };
  }

  buildAuthorizeRedirect(query: {
    client_id: string;
    redirect_uri: string;
    response_type: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }): { error?: string; redirectUrl?: string } {
    if (query.response_type !== 'code') {
      return { error: 'unsupported_response_type' };
    }

    const oauthState = randomBytes(16).toString('hex');
    this.authCodes.set(`pending_${oauthState}`, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    this.authCodes.set(`client_state_${oauthState}`, {
      clientId: query.state || '',
      redirectUri: '',
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: this.hackClubClientId,
      redirect_uri: `${this.baseUrl}/oauth/callback`,
      scope: 'email name',
      response_type: 'code',
      state: oauthState,
    });

    return {
      redirectUrl: `https://account.hackclub.com/oauth/authorize?${params.toString()}`,
    };
  }

  async handleOAuthCallback(query: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{ error?: string; redirectUrl?: string }> {
    const { code, state: oauthState, error } = query;

    if (error || !code || !oauthState) {
      return { error: 'Authorization failed' };
    }

    const pending = this.authCodes.get(`pending_${oauthState}`);
    const clientStateEntry = this.authCodes.get(`client_state_${oauthState}`);

    if (!pending || pending.expiresAt < Date.now()) {
      return { error: 'Authorization request expired' };
    }

    const tokenParams = new URLSearchParams({
      client_id: this.hackClubClientId,
      client_secret: this.hackClubClientSecret,
      redirect_uri: `${this.baseUrl}/oauth/callback`,
      code,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch(
      'https://account.hackclub.com/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      },
    );

    if (!tokenRes.ok) {
      throw new Error(
        `HC token exchange failed: ${await tokenRes.text()}`,
      );
    }

    const hcAccessToken = (await tokenRes.json()).access_token;

    const userRes = await fetch('https://account.hackclub.com/api/v1/me', {
      headers: { Authorization: `Bearer ${hcAccessToken}` },
    });
    if (!userRes.ok) throw new Error('Failed to fetch HC user info');

    const identity = (await userRes.json()).identity;

    const orchardToken = await new SignJWT({
      email: identity.primary_email,
      name: `${identity.first_name} ${identity.last_name}`,
      hackClubId: identity.id,
      authMethod: 'oauth',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.id)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.getJwtSecret());

    const mcpAuthCode = randomBytes(32).toString('hex');
    this.authCodes.set(mcpAuthCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      orchardToken,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    this.authCodes.delete(`pending_${oauthState}`);
    this.authCodes.delete(`client_state_${oauthState}`);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', mcpAuthCode);
    if (clientStateEntry?.clientId) {
      redirectUrl.searchParams.set('state', clientStateEntry.clientId);
    }

    return { redirectUrl: redirectUrl.toString() };
  }

  exchangeToken(body: {
    grant_type: string;
    code: string;
    redirect_uri?: string;
    client_id: string;
    code_verifier?: string;
  }): { error?: string; error_description?: string; token_response?: any } {
    if (body.grant_type !== 'authorization_code') {
      return { error: 'unsupported_grant_type' };
    }

    const authCode = this.authCodes.get(body.code);
    if (!authCode || authCode.expiresAt < Date.now()) {
      this.authCodes.delete(body.code);
      return { error: 'invalid_grant' };
    }

    if (authCode.clientId !== body.client_id) {
      return { error: 'invalid_client' };
    }

    if (authCode.redirectUri && authCode.redirectUri !== body.redirect_uri) {
      return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
    }

    if (authCode.codeChallenge) {
      if (!body.code_verifier) {
        return { error: 'invalid_grant', error_description: 'code_verifier required' };
      }
      const expectedChallenge = createHash('sha256')
        .update(body.code_verifier)
        .digest('base64url');
      if (expectedChallenge !== authCode.codeChallenge) {
        return { error: 'invalid_grant', error_description: 'code_verifier mismatch' };
      }
    }

    const orchardToken = authCode.orchardToken;
    this.authCodes.delete(body.code);

    return {
      token_response: {
        access_token: orchardToken,
        token_type: 'bearer',
        expires_in: 7 * 24 * 60 * 60,
        scope: 'mcp:access',
      },
    };
  }

  async validateBearerToken(authHeader?: string): Promise<string | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);
    try {
      await jwtVerify(token, this.getJwtSecret());
      return token;
    } catch {
      return null;
    }
  }
}
