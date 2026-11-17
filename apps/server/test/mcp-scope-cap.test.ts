import 'reflect-metadata';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { ScopeGuard, SuperAdminGuard } from '../src/auth/superadmin.guard';
import { REQUIRES_AUTH_KEY, REQUIRED_SCOPE_KEY } from '../src/auth/decorators';
import { capTokenScopes } from '../src/mcp/mcp-scopes';
import { graftToolScope } from '../src/mcp/catalog';
import { OrchardClient, type McpScope } from '../src/mcp/client';
import { executeCall } from '../src/mcp/compact/call-api';
import type { AgentOperation, AgentSpec } from '../src/agent-spec/agent-search';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-scope-cap';

const TOKEN = 'orch_' + 'b'.repeat(64);
const ALL: string[] = ['read', 'deploy', 'exec'];

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

function tokenGuard(scopes: string[]) {
  const prisma = {
    apiToken: {
      findUnique: async () => ({
        id: 'tok-1',
        expiresAt: null,
        scopes,
        restrictedProjectIds: [],
        scopeOrganizationId: null,
        user: {
          id: 'user-1',
          email: 'u@example.com',
          username: 'u',
          firstName: null,
          lastName: null,
          externalAuthId: null,
          disabledAt: null
        }
      }),
      update: async () => ({})
    },
    user: { findFirst: async () => ({ id: 'user-1', isSuperAdmin: false }) }
  };
  const sessions = { validateSession: async () => true, touchSession: async () => {} };
  return new SuperAdminGuard(
    prisma as any,
    sessions as any,
    reflector({ [REQUIRES_AUTH_KEY]: true }) as any
  );
}

async function reachesApi(
  tokenScopes: string[],
  method: string,
  headers: Record<string, string>,
  required?: McpScope
): Promise<boolean> {
  const request = {
    method,
    path: '/apiv1/deployments/d/restart',
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    cookies: {}
  } as any;
  assert.equal(await tokenGuard(tokenScopes).canActivate(context(request)), true);
  const scope = new ScopeGuard(
    reflector(required ? { [REQUIRED_SCOPE_KEY]: required } : {}) as any
  );
  try {
    return scope.canActivate(context(request));
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

function lowerHeaders(raw: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
}

async function sentHeaders(client: OrchardClient, method: string): Promise<Record<string, string>> {
  const realFetch = globalThis.fetch;
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    headers = lowerHeaders(init.headers as Record<string, string>);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await client.request(method, '/deployments/d/restart');
  } finally {
    globalThis.fetch = realFetch;
  }
  return headers;
}

describe('the API enforces the MCP scope cap on API tokens', () => {
  test('capTokenScopes only ever lowers', () => {
    assert.deepEqual(capTokenScopes(ALL, 'read'), ['read']);
    assert.deepEqual(capTokenScopes(['exec'], 'deploy'), ['deploy']);
    assert.deepEqual(capTokenScopes(['read'], 'exec'), ['read']);
    assert.deepEqual(capTokenScopes(['read', 'deploy'], 'exec'), ['read', 'deploy']);
    assert.deepEqual(capTokenScopes(ALL, undefined), ALL);
    assert.deepEqual(capTokenScopes(ALL, ''), ALL);
    assert.deepEqual(capTokenScopes(ALL, 'root'), ['read']);
    assert.deepEqual(capTokenScopes(ALL, ['read', 'exec']), ['read']);
    assert.deepEqual(capTokenScopes([], 'exec'), []);
  });

  test('a read cap header stops a deploy token at a deploy route', async () => {
    assert.equal(await reachesApi(ALL, 'POST', { 'x-acting-user-scope': 'read' }), false);
    assert.equal(await reachesApi(ALL, 'GET', { 'x-acting-user-scope': 'read' }), true);
    assert.equal(await reachesApi(ALL, 'POST', { 'x-acting-user-scope': 'deploy' }, 'exec'), false);
  });

  test('without the header a token keeps its own scopes', async () => {
    assert.equal(await reachesApi(ALL, 'POST', {}), true);
    assert.equal(await reachesApi(ALL, 'POST', {}, 'exec'), true);
  });

  test('the header cannot raise a token above its own scopes', async () => {
    assert.equal(await reachesApi(['read'], 'POST', { 'x-acting-user-scope': 'exec' }), false);
    assert.equal(
      await reachesApi(['deploy'], 'POST', { 'x-acting-user-scope': 'exec' }, 'exec'),
      false
    );
    assert.equal(
      await reachesApi(['read'], 'POST', { 'x-acting-user-scope': 'mcp:access' }),
      false
    );
  });

  test('the capped token is what the request carries downstream', async () => {
    const request = {
      method: 'GET',
      path: '/apiv1/deployments',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-acting-user-scope': 'read' },
      cookies: {}
    } as any;
    await tokenGuard(ALL).canActivate(context(request));
    assert.deepEqual(request.auth.tokenScopes, ['read']);
    assert.deepEqual(request.tokenScopes, ['read']);
  });
});

describe('the MCP client forwards the connection scope with a raw token', () => {
  test('a read-capped connection sends the cap and the API refuses deploy', async () => {
    const client = new OrchardClient('http://api.test', TOKEN, undefined, 'read');
    const headers = await sentHeaders(client, 'POST');
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['x-acting-user-scope'], 'read');
    assert.equal(await reachesApi(ALL, 'POST', headers), false);
  });

  test('an uncapped connection still reaches deploy and exec routes', async () => {
    const client = new OrchardClient('http://api.test', TOKEN, undefined, 'exec');
    const headers = await sentHeaders(client, 'POST');
    assert.equal(await reachesApi(ALL, 'POST', headers), true);
    assert.equal(await reachesApi(ALL, 'POST', headers, 'exec'), true);

    const bare = new OrchardClient('http://api.test', TOKEN);
    const bareHeaders = await sentHeaders(bare, 'POST');
    assert.equal(bareHeaders['x-acting-user-scope'], undefined);
    assert.equal(await reachesApi(ALL, 'POST', bareHeaders, 'exec'), true);
  });
});

describe('call_api under a scope cap', () => {
  const restart: AgentOperation = {
    operationId: 'deployments_restart',
    method: 'POST',
    path: '/deployments/:id/restart',
    summary: 'Restart',
    tags: ['deployments'],
    scope: 'deploy'
  };

  test('a read-capped connection is refused before the request', async () => {
    let called = false;
    const client = {
      request: async () => {
        called = true;
        return {};
      }
    };
    const result = await executeCall(
      client,
      restart,
      { operationId: restart.operationId, pathParams: { id: 'd' } },
      'read'
    );
    assert.equal(result.isError, true);
    assert.equal(called, false);
  });

  test('if the spec under-states a route the API still refuses it', async () => {
    const client = new OrchardClient('http://api.test', TOKEN, undefined, 'read');
    const headers = await sentHeaders(client, 'POST');
    const understated = { ...restart, scope: 'read' as const };
    let reached: boolean | undefined;
    const apiClient = {
      request: async () => {
        reached = await reachesApi(ALL, 'POST', headers);
        return reached ? {} : Promise.reject(new Error('HTTP 403'));
      }
    };
    const result = await executeCall(
      apiClient,
      understated,
      { operationId: understated.operationId, pathParams: { id: 'd' } },
      'read'
    );
    assert.equal(reached, false);
    assert.equal(result.isError, true);
  });

  test('an uncapped connection runs the deploy operation', async () => {
    const result = await executeCall(
      { request: async () => ({ ok: true }) },
      restart,
      { operationId: restart.operationId, pathParams: { id: 'd' } },
      'exec'
    );
    assert.equal(result.isError, undefined);
  });
});

describe('graft MCP tools follow the connection scope', () => {
  let root: string;
  const prev = { dir: process.env.ORCHARD_GRAFTS_DIR, dev: process.env.ORCHARD_GRAFTS_DEV };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'graft-mcp-scope-'));
    const dir = join(root, 'notes');
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(
      join(dir, 'graft.json'),
      JSON.stringify({
        id: 'notes',
        name: 'notes',
        version: '1.0.0',
        publisher: 'tests',
        engines: { platform: '>=0.0.0', sdk: '^1.0.0' },
        entries: { mcp: 'mcp/index.js' },
        capabilities: ['mcp']
      })
    );
    writeFileSync(
      join(dir, 'mcp/index.js'),
      `module.exports = { register(server, client) {
        globalThis.__notesClient = client;
        server.registerTool('notes_list', { annotations: { readOnlyHint: true } }, () => 1);
        server.registerTool('notes_start', { annotations: { readOnlyHint: false } }, () => 1);
        server.registerTool('notes_unhinted', {}, () => 1);
        server.registerTool('notes_shell', { annotations: { readOnlyHint: true }, _meta: { 'orchard/scope': 'exec' } }, () => 1);
        server.registerTool('notes_odd', { annotations: { readOnlyHint: true }, _meta: { 'orchard/scope': 'root' } }, () => 1);
      } };`
    );
    process.env.ORCHARD_GRAFTS_DIR = root;
    process.env.ORCHARD_GRAFTS_DEV = '1';
    const { loadMcpGrafts } = await import('../src/grafts/mcp');
    await loadMcpGrafts();
  });

  after(() => {
    if (prev.dir === undefined) delete process.env.ORCHARD_GRAFTS_DIR;
    else process.env.ORCHARD_GRAFTS_DIR = prev.dir;
    if (prev.dev === undefined) delete process.env.ORCHARD_GRAFTS_DEV;
    else process.env.ORCHARD_GRAFTS_DEV = prev.dev;
    rmSync(root, { recursive: true, force: true });
  });

  async function registered(scope?: McpScope): Promise<string[]> {
    const { registerGraftMcpTools } = await import('../src/grafts/mcp');
    const names: string[] = [];
    const server = { registerTool: (name: string) => names.push(name) };
    if (scope) registerGraftMcpTools(server, {}, () => true, scope);
    else registerGraftMcpTools(server, {});
    return names;
  }

  async function serverTools(scope: McpScope): Promise<string[]> {
    const { createOrchardMcpServer } = await import('../src/mcp/server');
    const server = createOrchardMcpServer({ token: TOKEN, scope, toolsets: 'notes' });
    return Object.keys((server as any)._registeredTools).filter((name) =>
      name.startsWith('notes_')
    );
  }

  test('graftToolScope reads the declared scope or the read-only hint', () => {
    assert.equal(graftToolScope({ annotations: { readOnlyHint: true } }), 'read');
    assert.equal(graftToolScope({ annotations: { readOnlyHint: false } }), 'deploy');
    assert.equal(graftToolScope({}), 'deploy');
    assert.equal(graftToolScope(undefined), 'deploy');
    assert.equal(graftToolScope({ _meta: { 'orchard/scope': 'exec' } }), 'exec');
    assert.equal(graftToolScope({ _meta: { 'orchard/scope': 'nope' } }), 'exec');
  });

  test('a read-capped connection only gets read-only graft tools', async () => {
    assert.deepEqual(await registered('read'), ['notes_list']);
    assert.deepEqual(await serverTools('read'), ['notes_list']);
  });

  test('a deploy-capped connection gets no exec graft tools', async () => {
    assert.deepEqual(await registered('deploy'), ['notes_list', 'notes_start', 'notes_unhinted']);
    assert.deepEqual(await serverTools('deploy'), ['notes_list', 'notes_start', 'notes_unhinted']);
  });

  test('an uncapped connection keeps every graft tool', async () => {
    const all = ['notes_list', 'notes_start', 'notes_unhinted', 'notes_shell', 'notes_odd'];
    assert.deepEqual(await registered(), all);
    assert.deepEqual(await serverTools('exec'), all);
  });

  test('the client a graft gets carries the cap to the API', async () => {
    await serverTools('read');
    const client = (globalThis as any).__notesClient as OrchardClient;
    const headers = await sentHeaders(client, 'POST');
    assert.equal(headers['x-acting-user-scope'], 'read');
    assert.equal(await reachesApi(ALL, 'POST', headers), false);
  });
});

describe('the agent spec takes each route scope from @RequireScope', () => {
  const contracts = resolve(__dirname, '../../../packages/contracts');
  const spec = JSON.parse(readFileSync(join(contracts, 'agent-spec.json'), 'utf8')) as AgentSpec;
  const declared = JSON.parse(
    readFileSync(join(__dirname, 'auth-scope.snapshot.json'), 'utf8')
  ) as Record<string, McpScope>;

  test('every operation carries its route scope or the method default', () => {
    for (const op of spec.operations) {
      const expected =
        declared[`${op.method} ${op.path}`] ?? (op.method === 'GET' ? 'read' : 'deploy');
      assert.equal(op.scope, expected, `${op.method} ${op.path}`);
    }
  });

  test('exec routes, graft routes included, are marked exec', () => {
    const byKey = new Map(spec.operations.map((op) => [`${op.method} ${op.path}`, op]));
    for (const key of [
      'POST /pods/:podName/exec',
      'POST /greenhouse/sandboxes/:id/sessions',
      'POST /greenhouse/sandboxes/:id/sessions/:sid/prompt',
      'GET /greenhouse/sandboxes/:id/diff'
    ]) {
      assert.equal(declared[key], 'exec', key);
      assert.equal(byKey.get(key)?.scope, 'exec', key);
    }
  });
});
