import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod4';
import type { AgentOperation } from '../src/agent-spec/agent-search';
import { OrchardApiError } from '../src/mcp/client';
import { SENSITIVE_META_KEY } from '../src/mcp/catalog';
import {
  OUTPUT_CAP,
  capOutput,
  executeCall,
  fillPath,
  projectFields
} from '../src/mcp/compact/call-api';
import { COMPACT_INSTRUCTIONS, registerCompactTools } from '../src/mcp/compact/compact-server';

const UUID = '3f1c2a4e-1111-4222-8333-444455556666';

const operations: AgentOperation[] = [
  {
    operationId: 'deployments_list',
    method: 'GET',
    path: '/deployments',
    summary: 'List deployments',
    tags: ['deployments'],
    scope: 'read'
  },
  {
    operationId: 'deployments_get',
    method: 'GET',
    path: '/deployments/:id',
    summary: 'Get a deployment',
    tags: ['deployments'],
    scope: 'read'
  },
  {
    operationId: 'deployments_restart',
    method: 'POST',
    path: '/deployments/:id/restart',
    summary: 'Restart a deployment',
    tags: ['deployments'],
    scope: 'deploy'
  },
  {
    operationId: 'databases_delete',
    method: 'DELETE',
    path: '/databases/:id',
    summary: 'Delete a database',
    tags: ['databases'],
    scope: 'deploy',
    'x-orchard-destructive': true
  },
  {
    operationId: 'databases_connection_get',
    method: 'GET',
    path: '/databases/:id/connection',
    summary: 'Database credentials',
    tags: ['databases'],
    scope: 'read',
    'x-orchard-sensitive': true
  },
  {
    operationId: 'pods_exec',
    method: 'POST',
    path: '/pods/:podName/exec',
    summary: 'Run a command in a pod',
    tags: ['pods'],
    scope: 'exec'
  }
];

const byId = (id: string) => operations.find((op) => op.operationId === id)!;

function fakeClient(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const value = responses[`${method} ${path}`];
      if (value instanceof Error) throw value;
      return value as any;
    }
  };
}

test('fillPath encodes values and reports what is missing', () => {
  assert.deepEqual(fillPath('/pods/:podName/logs', { podName: 'a/b' }), {
    path: '/pods/a%2Fb/logs',
    missing: [],
    invalid: []
  });
  assert.deepEqual(fillPath('/x/:id/y/:other', { id: '1' }), {
    missing: ['other'],
    invalid: []
  });
});

test('fillPath refuses dot segments that would change the route', () => {
  assert.deepEqual(fillPath('/deployments/:id/restart', { id: '..' }), {
    missing: [],
    invalid: ['id']
  });
  assert.deepEqual(fillPath('/deployments/:id', { id: '.' }).invalid, ['id']);
});

test('fields projects dotted paths through arrays and objects', () => {
  const value = {
    items: [
      { id: 'a', status: 'live', env: [{ key: 'X' }], noise: 1 },
      { id: 'b', status: 'crashing', env: [], noise: 2 }
    ],
    total: 2
  };
  assert.deepEqual(projectFields(value, ['items.id', 'items.status', 'total']), {
    items: [
      { id: 'a', status: 'live' },
      { id: 'b', status: 'crashing' }
    ],
    total: 2
  });
  assert.deepEqual(projectFields([{ id: 'a', x: 1 }], ['id']), [{ id: 'a' }]);
  assert.deepEqual(projectFields({ a: { b: 1, c: 2 } }, ['a']), { a: { b: 1, c: 2 } });
  assert.equal(projectFields(value, []), value);
});

test('output is capped with a marker that tells the model to use fields', () => {
  const capped = capOutput('x'.repeat(OUTPUT_CAP + 10));
  assert.ok(capped.startsWith('x'.repeat(100)));
  assert.match(capped, /truncated: the response is 24010 characters/);
  assert.match(capped, /fields/);
  assert.equal(capOutput('short'), 'short');
});

test('destructive operations refuse without confirm equal to the operationId', async () => {
  const client = fakeClient();
  const refused = await executeCall(
    client,
    byId('databases_delete'),
    { operationId: 'databases_delete', pathParams: { id: UUID } },
    'deploy'
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /confirm: "databases_delete"/);
  const wrong = await executeCall(
    client,
    byId('databases_delete'),
    { operationId: 'databases_delete', pathParams: { id: UUID }, confirm: 'yes' },
    'deploy'
  );
  assert.equal(wrong.isError, true);
  assert.equal(client.calls.length, 0, 'nothing reached the API');

  const ok = await executeCall(
    client,
    byId('databases_delete'),
    { operationId: 'databases_delete', pathParams: { id: UUID }, confirm: 'databases_delete' },
    'deploy'
  );
  assert.equal(ok.isError, undefined);
  assert.deepEqual(client.calls, [
    { method: 'DELETE', path: `/databases/${UUID}`, body: undefined }
  ]);
});

test('sensitive operations mark the result and others do not', async () => {
  const client = fakeClient({
    [`GET /databases/${UUID}/connection`]: { password: 'hunter2' },
    [`GET /deployments/${UUID}`]: { id: UUID }
  });
  const secret = await executeCall(
    client,
    byId('databases_connection_get'),
    { operationId: 'databases_connection_get', pathParams: { id: UUID } },
    'deploy'
  );
  assert.equal(secret._meta?.[SENSITIVE_META_KEY], true);
  const plain = await executeCall(
    client,
    byId('deployments_get'),
    { operationId: 'deployments_get', pathParams: { id: UUID } },
    'deploy'
  );
  assert.equal(plain._meta, undefined);
});

test('query, body and scope are honoured', async () => {
  const client = fakeClient({ 'GET /deployments?orgId=o1&tags=a&tags=b': [{ id: 'd' }] });
  const listed = await executeCall(
    client,
    byId('deployments_list'),
    { operationId: 'deployments_list', query: { orgId: 'o1', tags: ['a', 'b'], skip: null } },
    'read'
  );
  assert.equal(listed.content[0].text, '[{"id":"d"}]');

  const denied = await executeCall(
    client,
    byId('pods_exec'),
    { operationId: 'pods_exec', pathParams: { podName: 'p' }, body: { command: 'ls' } },
    'deploy'
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /mcp:exec/);

  await executeCall(
    client,
    byId('deployments_restart'),
    { operationId: 'deployments_restart', pathParams: { id: UUID }, body: { force: true } },
    'deploy'
  );
  assert.deepEqual(client.calls.at(-1), {
    method: 'POST',
    path: `/deployments/${UUID}/restart`,
    body: { force: true }
  });

  const missing = await executeCall(
    client,
    byId('deployments_restart'),
    { operationId: 'deployments_restart' },
    'deploy'
  );
  assert.match(missing.content[0].text, /Missing path parameter\(s\).*id/);
});

test('API errors come back as tool errors with the status', async () => {
  const client = fakeClient({
    [`GET /deployments/${UUID}`]: new OrchardApiError(404, 'Deployment not found')
  });
  const result = await executeCall(
    client,
    byId('deployments_get'),
    { operationId: 'deployments_get', pathParams: { id: UUID } },
    'read'
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 404 .*Deployment not found/);
});

function compactTools(scope: 'read' | 'deploy' | 'exec' = 'deploy') {
  const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  const server = {
    registerTool: (name: string, config: any, handler: any) => tools.set(name, { config, handler })
  };
  const client = fakeClient({ [`GET /deployments/${UUID}`]: { id: UUID, name: 'web' } });
  registerCompactTools(server as any, client, scope, { loadOperations: async () => operations });
  return { tools, client };
}

test('the compact server exposes exactly three tools that work end to end', async () => {
  const { tools } = compactTools();
  assert.deepEqual([...tools.keys()], ['search_api', 'describe_operation', 'call_api']);

  const search = JSON.parse(
    (await tools.get('search_api')!.handler({ query: 'restart deployment' })).content[0].text
  );
  assert.equal(search.results[0].operationId, 'deployments_restart');
  assert.equal(search.results[0].score, undefined);

  const described = JSON.parse(
    (await tools.get('describe_operation')!.handler({ operationId: 'GET /deployments/abc' }))
      .content[0].text
  );
  assert.equal(described.operationId, 'deployments_get');

  const unknown = await tools.get('describe_operation')!.handler({ operationId: 'nope' });
  assert.equal(unknown.isError, true);

  const called = await tools.get('call_api')!.handler({
    operationId: 'deployments_get',
    pathParams: { id: UUID },
    fields: ['name']
  });
  assert.equal(called.content[0].text, '{"name":"web"}');
});

test('the compact tool listing stays around 1k tokens', (t) => {
  const { tools } = compactTools();
  const listing = [...tools.entries()].map(([name, { config }]) => ({
    name,
    title: config.title,
    description: config.description,
    inputSchema: z.toJSONSchema(z.object(config.inputSchema)),
    annotations: config.annotations
  }));
  const chars = JSON.stringify(listing).length + COMPACT_INSTRUCTIONS.length;
  const tokens = Math.round(chars / 4);
  t.diagnostic(`compact tool listing: ${chars} chars, ~${tokens} tokens`);
  assert.ok(tokens < 1400, `compact listing is ~${tokens} tokens`);
});

test('the normal MCP path helper refuses dot segments', async () => {
  const { path: p } = await import('../src/mcp/client');
  assert.equal(p`/deployments/${'a b'}`, '/deployments/a%20b');
  assert.throws(() => p`/deployments/${'..'}/restart`);
});
