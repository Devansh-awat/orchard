import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMcpBodyLimits, MCP_MAX_BODY_BYTES } from '../src/mcp/body-limit';
import { registerCompactTools } from '../src/mcp/compact/compact-server';
import { McpTransportController } from '../src/mcp/mcp-transport.controller';
import { McpTransportService } from '../src/mcp/mcp-transport.service';

function transportWithoutAuth() {
  const seen = { authChecks: 0 };
  const oauth = {
    resourceMetadataUrl: 'http://mcp.test/.well-known/oauth-protected-resource',
    validateApiToken: async () => {
      seen.authChecks += 1;
      return null;
    },
    validateBearerTokenWithSub: async () => null
  };
  const transport = new McpTransportService(oauth as any, { configured: false } as any, {} as any);
  return { transport, seen };
}

function jsonRpcBody(paddingBytes: number) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'delete_env_vars', arguments: { keys: ['x'.repeat(paddingBytes)] } }
  });
}

async function bootApp() {
  const { NestFactory } = await import('@nestjs/core');
  const { Module } = await import('@nestjs/common');
  const { transport, seen } = transportWithoutAuth();

  @Module({
    controllers: [McpTransportController],
    providers: [{ provide: McpTransportService, useValue: transport }]
  })
  class TestMcpModule {}

  const app = await NestFactory.create<NestExpressApplication>(TestMcpModule, {
    bodyParser: false,
    logger: false
  });
  applyMcpBodyLimits(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, seen, url: `http://127.0.0.1:${port}/` };
}

function post(url: string, body: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body
  });
}

test('a JSON body over the limit gets a 413 before anything authenticates it', async () => {
  const { app, seen, url } = await bootApp();
  try {
    for (const path of ['', 'compact']) {
      const res = await post(url + path, jsonRpcBody(MCP_MAX_BODY_BYTES));
      assert.equal(res.status, 413);
      assert.equal((await res.json()).statusCode, 413);
    }
    assert.equal(seen.authChecks, 0);
  } finally {
    await app.close();
  }
});

test('a JSON body under the limit still reaches the transport', async () => {
  const { app, seen, url } = await bootApp();
  try {
    const res = await post(url, jsonRpcBody(MCP_MAX_BODY_BYTES - 1024));
    assert.equal(res.status, 401);
    assert.equal(seen.authChecks, 1);
  } finally {
    await app.close();
  }
});

function unparsedRequest(bytes: number) {
  return Object.assign(Readable.from([Buffer.alloc(bytes, 'x')]), {
    method: 'POST',
    url: '/',
    headers: { host: 'mcp.test', 'content-type': 'text/plain' }
  });
}

for (const mode of ['normal', 'compact'] as const) {
  test(`a ${mode} body the JSON parser skips is capped at the same limit`, async () => {
    const { transport, seen } = transportWithoutAuth();

    const over = unparsedRequest(MCP_MAX_BODY_BYTES + 1);
    const tooLarge = new ServerResponse(over as any);
    await transport.handle(over as any, tooLarge as any, mode);
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(seen.authChecks, 0);

    const under = unparsedRequest(MCP_MAX_BODY_BYTES);
    const accepted = new ServerResponse(under as any);
    await transport.handle(under as any, accepted as any, mode);
    assert.equal(accepted.statusCode, 401);
    assert.equal(seen.authChecks, 1);
  });
}

test('the MCP entrypoint installs the body limits', async () => {
  const source = await readFile(new URL('../src/mcp/main.ts', import.meta.url), 'utf8');
  assert.match(source, /bodyParser: false/);
  assert.match(source, /applyMcpBodyLimits\(app\)/);
});

function unboundedArrays(node: unknown, at: string, found: string[]) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => unboundedArrays(child, `${at}[${i}]`, found));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  if (schema.type === 'array' && schema.maxItems === undefined) found.push(at);
  for (const [key, child] of Object.entries(schema)) {
    unboundedArrays(child, `${at}.${key}`, found);
  }
}

test('every array in a tool input has a maximum length', async () => {
  const tools = new Map<string, any>();
  const server = {
    registerTool: (name: string, config: any) => {
      tools.set(name, config);
    }
  };
  const client = {};

  const dir = fileURLToPath(new URL('../src/mcp/tools/', import.meta.url));
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.ts'))) {
    const mod = await import(`${dir}${file}`);
    for (const [key, register] of Object.entries(mod)) {
      if (typeof register === 'function' && /^register.*Tools$/.test(key)) {
        (register as (server: unknown, client: unknown) => void)(server, client);
      }
    }
  }
  registerCompactTools(server as any, client as any, 'read', {
    loadOperations: async () => []
  });
  assert.ok(tools.size > 50, 'the walk should have collected the tool catalog');

  const found: string[] = [];
  for (const [name, config] of tools) {
    if (!config.inputSchema) continue;
    const schema = z.toJSONSchema(z.object(config.inputSchema), {
      io: 'input',
      unrepresentable: 'any'
    });
    unboundedArrays(schema, name, found);
  }
  assert.deepEqual(found, []);
});

test('the array bounds reject an oversized list and accept a large real one', async () => {
  const { registerDangerousTools } = await import('../src/mcp/tools/dangerous');
  const tools = new Map<string, any>();
  registerDangerousTools(
    {
      registerTool: (name: string, config: any) => {
        tools.set(name, config);
      }
    } as any,
    {} as any
  );
  const input = z.object(tools.get('delete_env_vars').inputSchema);
  const deploymentId = '3f1c2a4e-1111-4222-8333-444455556666';
  const keys = (count: number) => Array.from({ length: count }, (_, i) => `KEY_${i}`);
  assert.equal(input.safeParse({ deploymentId, keys: keys(1000) }).success, true);
  assert.equal(input.safeParse({ deploymentId, keys: keys(1001) }).success, false);
});
