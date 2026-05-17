import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { SessionsService } from '../auth/sessions.service';

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

  constructor(private readonly sessions: SessionsService) {}

  private get baseUrl(): string {
    return process.env.MCP_BASE_URL || 'http://localhost:3100';
  }

  private get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:5173';
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

  /**
   * Accept any https redirect URI, plus loopback http per RFC 8252. Safety
   * relies on PKCE S256, per-client redirect_uri binding at registration,
   * single-use auth codes, and the consent screen showing the full URI —
   * not on a host allowlist.
   */
  private isAllowedRedirectUri(uri: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    if (parsed.hash) return false;
    if (parsed.protocol === 'http:') {
      const h = parsed.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    }
    return parsed.protocol === 'https:';
  }

  registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }): { error?: string; error_description?: string; registration?: any } {
    console.error(`[MCP OAuth] Register client: name=${body.client_name}, redirect_uris=${JSON.stringify(body.redirect_uris)}`);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      return { error: 'invalid_redirect_uri', error_description: 'at least one redirect_uri is required' };
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !this.isAllowedRedirectUri(uri)) {
        return {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri must be https or loopback http (no userinfo, no fragment)',
        };
      }
    }

    const clientId = `mcp_${randomBytes(16).toString('hex')}`;
    const clientSecret =
      body.token_endpoint_auth_method === 'client_secret_post'
        ? randomBytes(32).toString('hex')
        : undefined;

    this.oauthClients.set(clientId, {
      clientId,
      clientSecret,
      redirectUris,
      name: body.client_name || 'MCP Client',
    });

    return {
      registration: {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: body.client_name || 'MCP Client',
        redirect_uris: redirectUris,
        grant_types: body.grant_types || ['authorization_code'],
        response_types: body.response_types || ['code'],
        token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
      },
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
    console.error(`[MCP OAuth] Authorize: client_id=${query.client_id}, redirect_uri=${query.redirect_uri}, state=${query.state}`);
    if (query.response_type !== 'code') {
      console.error(`[MCP OAuth] Authorize failed: unsupported_response_type=${query.response_type}`);
      return { error: 'unsupported_response_type' };
    }

    // Require PKCE with S256. Plain or missing challenges leave the auth code
    // exchangeable by anyone who intercepts the redirect — the authorization
    // server metadata only advertises S256, but the request shape must be
    // enforced here too so a malicious client can't downgrade.
    if (!query.code_challenge || query.code_challenge_method !== 'S256') {
      console.error(`[MCP OAuth] Authorize failed: PKCE S256 required`);
      return { error: 'invalid_request' };
    }

    // Reject unknown client_id and any redirect_uri not pre-registered. Without
    // this, an attacker registers (or guesses) a client and points the
    // redirect_uri at attacker.example, harvesting the victim's auth code.
    const client = this.oauthClients.get(query.client_id);
    if (!client) {
      console.error(`[MCP OAuth] Authorize failed: unknown client_id=${query.client_id}`);
      return { error: 'invalid_client' };
    }
    if (!client.redirectUris.includes(query.redirect_uri)) {
      console.error(`[MCP OAuth] Authorize failed: redirect_uri not registered for client`);
      return { error: 'invalid_redirect_uri' };
    }

    const mcpState = randomBytes(16).toString('hex');
    this.authCodes.set(`pending_${mcpState}`, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    this.authCodes.set(`client_state_${mcpState}`, {
      clientId: query.state || '',
      redirectUri: '',
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // Redirect to Orchard frontend login page with MCP state. client_name and
    // redirect_uri are passed for the consent screen to display — the actual
    // values used for the redirect come from the server-stored pending entry,
    // so tampering with these params changes only what the user sees, not where
    // the auth code is sent.
    const params = new URLSearchParams({
      mcp_state: mcpState,
      mcp_server: this.baseUrl,
      client_name: client.name,
      redirect_uri: query.redirect_uri,
    });

    return {
      redirectUrl: `${this.frontendUrl}/mcp/authorize?${params.toString()}`,
    };
  }

  async completeAuthorization(body: {
    mcp_state: string;
    session_token: string;
  }): Promise<{ error?: string; redirectUrl?: string }> {
    const { mcp_state, session_token } = body;
    console.error(`[MCP OAuth] Complete authorization: mcp_state=${mcp_state}`);

    const pending = this.authCodes.get(`pending_${mcp_state}`);
    const clientStateEntry = this.authCodes.get(`client_state_${mcp_state}`);

    if (!pending || pending.expiresAt < Date.now()) {
      console.error(`[MCP OAuth] Complete auth failed: pending not found or expired`);
      return { error: 'Authorization request expired' };
    }

    // Validate the Orchard session token (same JWT_SECRET)
    let payload: any;
    try {
      const result = await jwtVerify(session_token, this.getJwtSecret());
      payload = result.payload;
      console.error(`[MCP OAuth] Session token valid: sub=${payload.sub}, email=${payload.email}`);
    } catch (err) {
      console.error(`[MCP OAuth] Session token invalid: ${err instanceof Error ? err.message : err}`);
      return { error: 'Invalid session token' };
    }

    // H6: Require a sessionId on the originating session token so MCP tokens
    // inherit session revocation. Pre-fix, MCP tokens lived 7 days regardless
    // of whether the user signed out everywhere.
    if (!payload.sessionId) {
      return { error: 'Session token missing session binding' };
    }
    // Carry the same sessionId so SuperAdminGuard's session check applies on
    // every MCP request, and shorten lifetime to 1d.
    //
    // M-2: stamp `type: 'mcp'` so SuperAdminGuard can reject MCP-issued tokens
    // when they're replayed at the main Orchard API. Both JWTs use the same
    // HS256 secret, so without a type discriminator a leaked MCP access token
    // is indistinguishable from a first-party browser session JWT.
    const orchardToken = await new SignJWT({
      type: 'mcp',
      email: payload.email,
      name: payload.name,
      hackClubId: payload.hackClubId,
      authMethod: payload.authMethod || 'otp',
      sessionId: payload.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime('1d')
      .sign(this.getJwtSecret());

    const mcpAuthCode = randomBytes(32).toString('hex');
    console.error(`[MCP OAuth] MCP auth code created, redirecting to ${pending.redirectUri}`);
    this.authCodes.set(mcpAuthCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      orchardToken,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    this.authCodes.delete(`pending_${mcp_state}`);
    this.authCodes.delete(`client_state_${mcp_state}`);

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
    console.error(`[MCP OAuth] Token exchange: grant_type=${body.grant_type}, client_id=${body.client_id}, code_length=${body.code?.length}, redirect_uri=${body.redirect_uri}`);
    if (body.grant_type !== 'authorization_code') {
      console.error(`[MCP OAuth] Token exchange failed: unsupported_grant_type`);
      return { error: 'unsupported_grant_type' };
    }

    const authCode = this.authCodes.get(body.code);
    console.error(`[MCP OAuth] Token exchange: authCode found=${!!authCode}, authCodes size=${this.authCodes.size}`);
    if (!authCode || authCode.expiresAt < Date.now()) {
      console.error(`[MCP OAuth] Token exchange failed: invalid_grant (not found or expired)`);
      this.authCodes.delete(body.code);
      return { error: 'invalid_grant' };
    }

    if (authCode.clientId !== body.client_id) {
      console.error(`[MCP OAuth] Token exchange failed: invalid_client (expected=${authCode.clientId}, got=${body.client_id})`);
      return { error: 'invalid_client' };
    }

    // Re-check both that the exchange request's redirect_uri matches the one
    // bound to the auth code AND that it is still in the client's registered
    // list (defense against the registered list being mutated after authorize).
    const client = this.oauthClients.get(body.client_id);
    if (!client) {
      return { error: 'invalid_client' };
    }
    if (authCode.redirectUri && authCode.redirectUri !== body.redirect_uri) {
      console.error(`[MCP OAuth] Token exchange failed: redirect_uri mismatch (expected=${authCode.redirectUri}, got=${body.redirect_uri})`);
      return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
    }
    if (!client.redirectUris.includes(body.redirect_uri ?? '')) {
      return { error: 'invalid_redirect_uri' };
    }

    // PKCE is mandatory — /authorize already rejects challenge-less requests,
    // but enforce again here so the token endpoint cannot be bypassed even if
    // an auth code somehow lands without a stored challenge.
    if (!authCode.codeChallenge || authCode.codeChallengeMethod !== 'S256') {
      console.error(`[MCP OAuth] Token exchange failed: PKCE S256 required on stored code`);
      return { error: 'invalid_grant', error_description: 'PKCE required' };
    }
    if (!body.code_verifier) {
      console.error(`[MCP OAuth] Token exchange failed: code_verifier required`);
      return { error: 'invalid_grant', error_description: 'code_verifier required' };
    }
    const expectedChallenge = createHash('sha256')
      .update(body.code_verifier)
      .digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      console.error(`[MCP OAuth] Token exchange failed: code_verifier mismatch`);
      return { error: 'invalid_grant', error_description: 'code_verifier mismatch' };
    }

    const orchardToken = authCode.orchardToken;
    this.authCodes.delete(body.code);

    return {
      token_response: {
        access_token: orchardToken,
        token_type: 'Bearer',
        expires_in: 7 * 24 * 60 * 60,
        scope: 'mcp:access',
      },
    };
  }

  async validateBearerToken(authHeader?: string): Promise<string | null> {
    const result = await this.validateBearerTokenWithSub(authHeader);
    return result?.token ?? null;
  }

  /**
   * Same checks as `validateBearerToken` but also returns the JWT `sub`
   * claim so callers can bind a long-lived stateful resource (MCP transport
   * sessions) to the user who created it. Without this binding, a leaked
   * `mcp-session-id` lets any other authenticated MCP user dispatch tool
   * calls against the original creator's `OrchardClient` (i.e. their
   * orchard token), running as that user against the first-party API.
   */
  async validateBearerTokenWithSub(
    authHeader?: string,
  ): Promise<{ token: string; sub: string } | null> {
    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[MCP OAuth] No Bearer token in header');
      return null;
    }
    const token = authHeader.substring(7);
    console.error(`[MCP OAuth] Token length: ${token.length}, prefix: ${token.substring(0, 20)}...`);
    try {
      const result = await jwtVerify(token, this.getJwtSecret());

      // M-2: MCP must only accept tokens this service minted. A first-party
      // browser-session JWT (issued by oauth.service / passwordless / SSO) is
      // signed with the same secret and therefore passes jwtVerify — but it
      // is not the credential the user consented to share with the MCP client.
      // Reject anything that isn't type='mcp'.
      if (result.payload.type !== 'mcp') {
        console.error('[MCP OAuth] Token rejected: wrong token type');
        return null;
      }

      // MCP runs in its own Nest app and does NOT pass through SuperAdminGuard,
      // so the session check has to happen here. Without this, "sign out
      // everywhere" / session revocation / role downgrade does not invalidate
      // an MCP access token until its 1-day expiry — the originating sessionId
      // was carried in the JWT precisely so we could honor revocation, but
      // nothing was actually checking it.
      const sessionId = result.payload.sessionId as string | undefined;
      if (!sessionId) {
        console.error('[MCP OAuth] Token rejected: missing sessionId binding');
        return null;
      }
      const sessionValid = await this.sessions.validateSession(sessionId);
      if (!sessionValid) {
        console.error('[MCP OAuth] Token rejected: session has been revoked');
        return null;
      }
      this.sessions.touchSession(sessionId).catch(() => {});

      const sub = result.payload.sub as string | undefined;
      if (!sub) {
        console.error('[MCP OAuth] Token rejected: missing sub claim');
        return null;
      }

      console.error(`[MCP OAuth] Token valid, sub: ${sub}, exp: ${result.payload.exp}`);
      return { token, sub };
    } catch (err) {
      console.error(`[MCP OAuth] Token verification failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
