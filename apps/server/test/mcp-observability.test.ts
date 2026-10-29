import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerObservabilityTools } from '../src/mcp/tools/observability';
import { registerQueryTools } from '../src/mcp/tools/query';
import { OUTPUT_CAP, capJson, capLines, capList, cursorBefore } from '../src/mcp/tools/reply';

type Handler = (input: any) => Promise<{ content: { text: string }[] }>;

function harness(respond: (route: string) => unknown) {
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler)
  };
  const client = {
    get: async (route: string) => {
      calls.push(route);
      return respond(route);
    }
  };
  registerObservabilityTools(server as any, client as any);
  registerQueryTools(server as any, client as any);
  return { handlers, calls };
}

const entry = (i: number) => ({
  timestamp: new Date(Date.UTC(2026, 9, 28, 12, 0, 0) - i * 1000).toISOString(),
  level: 'INFO',
  raw: `GET /api/things/${i} 200 ${'x'.repeat(200)}`,
  metadata: { pod: 'api-1' }
});

test('log lines are capped near 40 KB with a cursor to the next older page', () => {
  const entries = Array.from({ length: 1000 }, (_, i) => entry(i));
  const capped = capLines(entries, null);
  assert.equal(capped.truncated, true);
  assert.ok(capped.lines.join('\n').length <= OUTPUT_CAP);
  const end = JSON.parse(Buffer.from(capped.cursor!, 'base64url').toString()).end;
  assert.equal(end, Date.parse(entries[capped.lines.length - 1].timestamp) - 1);
});

test('a small page passes the server cursor through untouched', () => {
  assert.deepEqual(capLines([entry(0)], 'abc'), {
    lines: [`${entry(0).timestamp} api-1 INFO ${entry(0).raw}`],
    truncated: true,
    cursor: 'abc'
  });
  assert.equal(capLines([entry(0)], null).truncated, false);
  assert.equal(cursorBefore('nope'), null);
});

test('lists and objects are capped too', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'y'.repeat(50) }));
  const list = capList(big);
  assert.equal(list.truncated, true);
  assert.ok(JSON.stringify(list.items).length <= OUTPUT_CAP);
  assert.equal(list.nextCursor, String(list.items.length));
  assert.equal((capJson({ huge: 'z'.repeat(OUTPUT_CAP) }) as any).truncated, true);
  assert.deepEqual(capJson({ ok: 1 }), { ok: 1 });
});

test('search_logs sends typed filters and answers in text lines', async () => {
  const { handlers, calls } = harness(() => ({
    source: 'store',
    entries: Array.from({ length: 600 }, (_, i) => entry(i)),
    cursor: 'next'
  }));
  const out = await handlers.get('search_logs')!({
    deploymentId: '00000000-0000-4000-8000-000000000000',
    q: 'timeout "upstream reset"',
    levels: ['error', 'warn'],
    limit: 500
  });
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.source, 'store');
  assert.equal(body.truncated, true);
  assert.ok(out.content[0].text.length < OUTPUT_CAP + 2000);
  assert.match(calls[0], /\/logs\/search\?/);
  assert.match(calls[0], /levels=error%2Cwarn/);
  assert.match(calls[0], /limit=500/);
});

test('get_deployment_logs delegates to the store search instead of the triple shape', async () => {
  const { handlers, calls } = harness(() => ({
    source: 'live',
    entries: [entry(1)],
    cursor: null
  }));
  const out = await handlers.get('get_deployment_logs')!({
    deploymentId: '00000000-0000-4000-8000-000000000000',
    level: 'ERROR',
    tailLines: 5000
  });
  const body = JSON.parse(out.content[0].text);
  assert.deepEqual(Object.keys(body).sort(), ['cursor', 'lines', 'source', 'truncated']);
  assert.match(calls[0], /\/logs\/search\?/);
  assert.match(calls[0], /levels=error/);
  assert.match(calls[0], /limit=500/);
});

test('diagnose_deployment reads the diagnosis endpoint with the zone', async () => {
  const { handlers, calls } = harness(() => ({ health: { app: 'down' } }));
  await handlers.get('diagnose_deployment')!({
    deploymentId: '00000000-0000-4000-8000-000000000000',
    timezone: 'Europe/London'
  });
  assert.equal(
    calls[0],
    '/deployments/00000000-0000-4000-8000-000000000000/diagnosis?tz=Europe%2FLondon'
  );
});

test('a line keeps one timestamp even when the raw text starts with its own', () => {
  const line = capLines(
    [
      {
        timestamp: '2026-10-29T07:47:21.635760109Z',
        level: 'INFO',
        raw: '2026-10-29T07:47:21.635760109Z Completed 200 OK',
        metadata: { pod: 'attend-1' }
      }
    ],
    null
  ).lines[0];
  assert.equal(line, '2026-10-29T07:47:21.635760109Z attend-1 INFO Completed 200 OK');
});
