import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-token-type';

const MCP_DIR = join(__dirname, '..', 'src', 'mcp');

test('MCP access tokens are stamped type=mcp', async () => {
  const svc = new McpOAuthService({} as any, {} as any);

  const token = await (svc as any).mintAccessToken({
    sub: 'user-1',
    email: 'someone@example.com',
    name: 'Someone',
    externalAuthId: 'ext-1',
    authMethod: 'otp',
    sessionId: 'session-1'
  });

  const claims = decodeJwt(token);
  assert.equal(
    claims.type,
    'mcp',
    'SuperAdminGuard rejects on this claim; without it the token is a first-party session'
  );
  assert.equal(claims.sessionId, 'session-1');
  assert.equal(claims.sub, 'user-1');
});

// A typeless mint under src/mcp is what made the old standalone remote.ts
// entrypoint an account-takeover primitive: SuperAdminGuard only rejects
// `type === 'mcp'`, so a token minted without it sails through as a real
// browser session. Keep every signer in this directory honest.
test('no JWT is minted under src/mcp without a type claim', () => {
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/new SignJWT\(\{/g)) {
        const body = source.slice(match.index!, source.indexOf('.sign(', match.index!));
        if (!/\btype:/.test(body)) {
          offenders.push(`${full} (offset ${match.index})`);
        }
      }
    }
  };

  walk(MCP_DIR);

  assert.deepEqual(offenders, [], `SignJWT without a type claim:\n${offenders.join('\n')}`);
});
