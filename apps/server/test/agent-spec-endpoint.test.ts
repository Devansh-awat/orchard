import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentSpecController } from '../src/agent-spec/agent-spec.controller';
import {
  etagMatches,
  findContractsFile,
  readContractsFile,
  toContractsFile
} from '../src/agent-spec/contracts-files';
import { IS_PUBLIC_KEY } from '../src/auth/decorators';

function fakeResponse() {
  const res: any = { headers: {}, statusCode: 0, body: undefined as unknown };
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.type = (t: string) => {
    res.headers['content-type'] = t;
    return res;
  };
  res.send = (body: unknown) => {
    res.body = body;
    return res;
  };
  res.end = () => res;
  return res;
}

test('the bundled agent spec and openapi document are found from the server tree', () => {
  assert.ok(findContractsFile('agent-spec.json'), 'agent-spec.json is reachable');
  assert.ok(findContractsFile('openapi.json'), 'openapi.json is reachable');
  assert.equal(findContractsFile('nope.json'), null);
});

test('agent-spec.json is served with an ETag and cache headers, and 304s on a match', () => {
  const controller = new AgentSpecController();
  const first = fakeResponse();
  controller.agentSpec({ headers: {} } as any, first);
  assert.equal(first.statusCode, 200);
  assert.match(first.headers.etag, /^"[0-9a-f]{32}"$/);
  assert.match(first.headers['cache-control'], /max-age=300/);
  const spec = JSON.parse(String(first.body));
  assert.ok(Array.isArray(spec.operations) && spec.operations.length > 100);
  assert.ok(spec.operations.every((op: any) => !op.path.startsWith('/admin')));

  const again = fakeResponse();
  controller.agentSpec({ headers: { 'if-none-match': first.headers.etag } } as any, again);
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, undefined);

  assert.equal(readContractsFile('agent-spec.json')?.etag, first.headers.etag);
});

test('both routes are public', () => {
  for (const method of ['agentSpec', 'openapi'] as const) {
    assert.equal(
      Reflect.getMetadata(IS_PUBLIC_KEY, AgentSpecController.prototype[method]),
      true,
      method
    );
  }
});

test('etag matching understands lists, weak tags and wildcards', () => {
  const { etag } = toContractsFile(Buffer.from('x'));
  assert.equal(etagMatches(`W/${etag}`, etag), true);
  assert.equal(etagMatches(`"other", ${etag}`, etag), true);
  assert.equal(etagMatches('*', etag), true);
  assert.equal(etagMatches('"other"', etag), false);
  assert.equal(etagMatches(undefined, etag), false);
});

test('the server copy of agent-search matches the contracts source', () => {
  const canonical = findContractsFile('src/agent-search.ts');
  assert.ok(canonical, 'packages/contracts/src/agent-search.ts is reachable');
  assert.equal(
    readFileSync(join(__dirname, '../src/agent-spec/agent-search.ts'), 'utf8'),
    readFileSync(canonical, 'utf8'),
    'run `pnpm --filter @orchard/contracts generate` to resync'
  );
});
