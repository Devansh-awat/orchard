import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ScopeGuard, SuperAdminGuard } from '../src/auth/superadmin.guard';
import { REQUIRES_AUTH_KEY, REQUIRED_SCOPE_KEY } from '../src/auth/decorators';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-gateway-scope';
process.env.MCP_SERVICE_TOKEN = 'svc-token-for-tests';

function reflector(meta: Record<string, unknown> = {}) {
  return {
    get: (key: string) => meta[key],
    getAllAndOverride: (key: string) => meta[key]
  };
}

function context(request: any) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => {},
    getClass: () => class {}
  } as any;
}

function gatewayRequest(method: string, path: string, scope?: string) {
  return {
    method,
    path,
    headers: {
      authorization: 'Bearer svc-token-for-tests',
      'x-acting-user-sub': 'user-1',
      'x-acting-user-session-id': 'sess-1',
      ...(scope ? { 'x-acting-user-scope': scope } : {})
    },
    cookies: {}
  } as any;
}

function guard() {
  const prisma = {
    session: { findUnique: async () => ({ userId: 'user-1', deviceName: 'Claude' }) },
    user: { findFirst: async () => ({ isSuperAdmin: true }) }
  };
  const sessions = { validateSession: async () => true, touchSession: async () => {} };
  return new SuperAdminGuard(
    prisma as any,
    sessions as any,
    reflector({ [REQUIRES_AUTH_KEY]: true }) as any
  );
}

test('the gateway path carries the MCP scope into the request', async () => {
  const req = gatewayRequest('GET', '/apiv1/deployments', 'read');
  assert.equal(await guard().canActivate(context(req)), true);
  assert.equal(req.auth.mcpScoped, true);
  assert.deepEqual(req.auth.tokenScopes, ['read']);
});

test('a gateway request without a scope header is treated as deploy', async () => {
  const req = gatewayRequest('POST', '/apiv1/deployments/x/restart');
  await guard().canActivate(context(req));
  assert.deepEqual(req.auth.tokenScopes, ['deploy']);
});

test('the gateway path refuses the routes API tokens cannot reach', async () => {
  for (const path of [
    '/apiv1/admin/users',
    '/apiv1/setup/complete',
    '/apiv1/auth/mcp-token',
    '/apiv1/auth/tokens'
  ]) {
    await assert.rejects(
      guard().canActivate(context(gatewayRequest('GET', path, 'exec'))),
      ForbiddenException,
      path
    );
  }
});

test('ScopeGuard applies token scope semantics to MCP gateway requests', () => {
  const scope = new ScopeGuard(reflector() as any);
  const read = { method: 'POST', auth: { mcpScoped: true, tokenScopes: ['read'] } };
  assert.throws(() => scope.canActivate(context(read)), ForbiddenException);
  const deploy = { method: 'POST', auth: { mcpScoped: true, tokenScopes: ['deploy'] } };
  assert.equal(scope.canActivate(context(deploy)), true);
  const get = { method: 'GET', auth: { mcpScoped: true, tokenScopes: ['read'] } };
  assert.equal(scope.canActivate(context(get)), true);

  const execRoute = new ScopeGuard(reflector({ [REQUIRED_SCOPE_KEY]: 'exec' }) as any);
  assert.throws(() => execRoute.canActivate(context(deploy)), ForbiddenException);
  const exec = { method: 'POST', auth: { mcpScoped: true, tokenScopes: ['exec'] } };
  assert.equal(execRoute.canActivate(context(exec)), true);

  const session = { method: 'POST', auth: { userId: 'u' } };
  assert.equal(scope.canActivate(context(session)), true);
});
