import express from 'express';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOrchardMcpServer } from './server';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MCP_BASE_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const HACKCLUB_CLIENT_ID = process.env.HACKCLUB_CLIENT_ID;
const HACKCLUB_CLIENT_SECRET = process.env.HACKCLUB_CLIENT_SECRET;

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return new TextEncoder().encode(secret);
}

// In-memory stores (only for short-lived OAuth flow state)
const oauthClients = new Map<string, { clientId: string; clientSecret?: string; redirectUris: string[]; name: string }>();
const authCodes = new Map<string, { clientId: string; redirectUri: string; codeChallenge?: string; codeChallengeMethod?: string; orchardToken: string; expiresAt: number }>();
const transports = new Map<string, StreamableHTTPServerTransport>();

const RESOURCE_METADATA_URL = `${MCP_BASE_URL}/.well-known/oauth-protected-resource`;

// --- OAuth 2.0 Protected Resource Metadata (RFC 9728) ---
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: MCP_BASE_URL,
    authorization_servers: [MCP_BASE_URL],
    scopes_supported: ['mcp:access'],
    bearer_methods_supported: ['header'],
  });
});


// --- OAuth 2.0 Authorization Server Metadata (RFC 8414) ---
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: MCP_BASE_URL,
    authorization_endpoint: `${MCP_BASE_URL}/authorize`,
    token_endpoint: `${MCP_BASE_URL}/token`,
    registration_endpoint: `${MCP_BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:access'],
  });
});

// --- Dynamic Client Registration (RFC 7591) ---
app.post('/register', (req, res) => {
  const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;

  const clientId = `mcp_${randomBytes(16).toString('hex')}`;
  const clientSecret = token_endpoint_auth_method === 'client_secret_post'
    ? randomBytes(32).toString('hex')
    : undefined;

  oauthClients.set(clientId, {
    clientId,
    clientSecret,
    redirectUris: redirect_uris || [],
    name: client_name || 'MCP Client',
  });

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris || [],
    grant_types: grant_types || ['authorization_code'],
    response_types: response_types || ['code'],
    token_endpoint_auth_method: token_endpoint_auth_method || 'none',
  });
});

// --- Authorization Endpoint ---
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } =
    req.query as Record<string, string>;

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }

  const oauthState = randomBytes(16).toString('hex');
  authCodes.set(`pending_${oauthState}`, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    orchardToken: '',
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  authCodes.set(`client_state_${oauthState}`, {
    clientId: state || '',
    redirectUri: '',
    orchardToken: '',
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    client_id: HACKCLUB_CLIENT_ID!,
    redirect_uri: `${MCP_BASE_URL}/oauth/callback`,
    scope: 'email name',
    response_type: 'code',
    state: oauthState,
  });

  res.redirect(`https://account.hackclub.com/oauth/authorize?${params.toString()}`);
});

// --- Hack Club OAuth Callback ---
app.get('/oauth/callback', async (req, res) => {
  const { code, state: oauthState, error } = req.query as Record<string, string>;

  if (error || !code || !oauthState) {
    return res.status(400).send('Authorization failed');
  }

  const pending = authCodes.get(`pending_${oauthState}`);
  const clientStateEntry = authCodes.get(`client_state_${oauthState}`);

  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).send('Authorization request expired');
  }

  try {
    const tokenParams = new URLSearchParams({
      client_id: HACKCLUB_CLIENT_ID!,
      client_secret: HACKCLUB_CLIENT_SECRET!,
      redirect_uri: `${MCP_BASE_URL}/oauth/callback`,
      code,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch('https://account.hackclub.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) throw new Error(`HC token exchange failed: ${await tokenRes.text()}`);

    const hcAccessToken = (await tokenRes.json()).access_token;

    const userRes = await fetch('https://account.hackclub.com/api/v1/me', {
      headers: { Authorization: `Bearer ${hcAccessToken}` },
    });
    if (!userRes.ok) throw new Error('Failed to fetch HC user info');

    const identity = (await userRes.json()).identity;

    // Generate Orchard JWT
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
      .sign(getJwtSecret());

    // Generate MCP auth code
    const mcpAuthCode = randomBytes(32).toString('hex');
    authCodes.set(mcpAuthCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      orchardToken,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    authCodes.delete(`pending_${oauthState}`);
    authCodes.delete(`client_state_${oauthState}`);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', mcpAuthCode);
    if (clientStateEntry?.clientId) {
      redirectUrl.searchParams.set('state', clientStateEntry.clientId);
    }

    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed');
  }
});

// --- Token Endpoint ---
// Returns the Orchard JWT directly as the access_token (stateless validation)
app.post('/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const authCode = authCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) {
    authCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  if (authCode.clientId !== client_id) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  if (authCode.redirectUri && authCode.redirectUri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  if (authCode.codeChallenge) {
    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
    }
    const expectedChallenge = createHash('sha256').update(code_verifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' });
    }
  }

  // Return the Orchard JWT directly — survives server restarts
  const orchardToken = authCode.orchardToken;
  authCodes.delete(code);

  res.json({
    access_token: orchardToken,
    token_type: 'Bearer',
    expires_in: 7 * 24 * 60 * 60,
    scope: 'mcp:access',
  });
});

// --- Stateless Bearer token validation ---
async function extractOrchardToken(req: express.Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7);
  try {
    await jwtVerify(token, getJwtSecret());
    return token;
  } catch {
    return null;
  }
}

function send401(res: express.Response) {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="mcp:access"`,
  );
  res.status(401).json({ error: 'Unauthorized' });
}

// --- MCP Endpoints ---

app.post('/', async (req, res) => {
  console.error(`[MCP] POST / - session: ${req.headers['mcp-session-id'] || 'none'}, auth: ${req.headers.authorization ? 'present' : 'missing'}, body method: ${req.body?.method || 'N/A'}`);
  try {
    const orchardToken = await extractOrchardToken(req);
    if (!orchardToken) { console.error('[MCP] POST / - auth failed (invalid token)'); send401(res); return; }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !transports.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createOrchardMcpServer(orchardToken);

    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) transports.delete(sid);
    };

    await server.connect(transport);

    const sid = (transport as any).sessionId as string;
    if (sid) transports.set(sid, transport);

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP POST error:', err instanceof Error ? err.stack : err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: err instanceof Error ? err.message : String(err) });
    }
  }
});

app.get('/', async (req, res) => {
  const orchardToken = await extractOrchardToken(req);
  if (!orchardToken) { send401(res); return; }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete('/', async (req, res) => {
  const orchardToken = await extractOrchardToken(req);
  if (!orchardToken) { send401(res); return; }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
  transports.delete(sessionId);
});

const port = parseInt(process.env.MCP_PORT || process.env.PORT || '3100', 10);
const host = process.env.MCP_HOST || process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.error(`Orchard MCP Server (HTTP) listening on http://${host}:${port}/`);
});
