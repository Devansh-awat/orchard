import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod4';
import {
  DEFAULT_TOOLSETS,
  SENSITIVE_META_KEY,
  TOOL_CATALOG,
  catalogServer,
  parseToolsets
} from '../src/mcp/catalog';
import { path, query } from '../src/mcp/client';
import { registerQueryTools } from '../src/mcp/tools/query';
import { registerDeploymentTools } from '../src/mcp/tools/deployments';
import { registerConfigurationTools } from '../src/mcp/tools/configuration';
import { registerResourceTools } from '../src/mcp/tools/resources';
import { registerNotificationTools } from '../src/mcp/tools/notifications';
import { registerJobTools } from '../src/mcp/tools/jobs';
import { registerEnvironmentTools } from '../src/mcp/tools/environments';
import { registerDangerousTools } from '../src/mcp/tools/dangerous';
import { registerRolloutTools } from '../src/mcp/tools/rollout';
import { registerObservabilityTools } from '../src/mcp/tools/observability';
import { registerComposeTools } from '../src/mcp/tools/compose';
import { registerDocResources, fetchLlmsTxt } from '../src/mcp/tools/docs';

const REGISTER = [
  registerQueryTools,
  registerDeploymentTools,
  registerRolloutTools,
  registerObservabilityTools,
  registerComposeTools,
  registerConfigurationTools,
  registerResourceTools,
  registerNotificationTools,
  registerJobTools,
  registerEnvironmentTools,
  registerDangerousTools
];

interface Captured {
  config: any;
  handler: (...args: any[]) => any;
}

function capture(
  toolsets = 'all',
  scope: 'read' | 'deploy' | 'exec' = 'exec',
  responses: Record<string, any> = {}
) {
  const tools = new Map<string, Captured>();
  const raw = {
    registerTool: (name: string, config: any, handler: any) => {
      tools.set(name, { config, handler });
    }
  };
  const calls: { method: string; path: string; body?: any }[] = [];
  const respond = (method: string) => async (p: string, body?: any) => {
    calls.push({ method, path: p, body });
    return responses[p] ?? {};
  };
  const client = {
    get: respond('GET'),
    post: respond('POST'),
    put: respond('PUT'),
    patch: respond('PATCH'),
    delete: respond('DELETE')
  };
  const server = catalogServer(raw, { selection: parseToolsets(toolsets), scope });
  for (const register of REGISTER) register(server as any, client as any);
  return { tools, calls };
}

function rawNames(): string[] {
  const names: string[] = [];
  const raw = { registerTool: (name: string) => names.push(name) };
  const client = new Proxy({}, { get: () => async () => ({}) });
  for (const register of REGISTER) register(raw as any, client as any);
  return names;
}

test('every registered tool has a catalog entry and every entry is registered', () => {
  const names = rawNames();
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  const missing = names.filter((name) => !TOOL_CATALOG[name]);
  assert.deepEqual(missing, []);
  const stale = Object.keys(TOOL_CATALOG).filter((name) => !names.includes(name));
  assert.deepEqual(stale, []);
});

test('every tool carries a title and the full annotation set', () => {
  const { tools } = capture();
  assert.ok(tools.size > 150, `expected the full tool list, got ${tools.size}`);
  for (const [name, { config }] of tools) {
    assert.ok(config.title, `${name} has a title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof config.annotations[hint], 'boolean', `${name}.${hint}`);
    }
    if (config.annotations.readOnlyHint) {
      assert.equal(config.annotations.destructiveHint, false, `${name} is read-only`);
    }
  }
});

test('full-replace tools are destructive, merges are not', () => {
  const { tools } = capture();
  for (const name of [
    'update_deployment_volumes',
    'update_database_settings',
    'set_env_vars',
    'update_service',
    'set_shared_env_vars',
    'replace_job_steps'
  ]) {
    assert.equal(tools.get(name)!.config.annotations.destructiveHint, true, name);
  }
  for (const name of ['add_env_vars', 'add_shared_env_vars', 'update_deployment_health_check']) {
    assert.equal(tools.get(name)!.config.annotations.destructiveHint, false, name);
  }
});

test('sensitive tools are marked in _meta, the description and their results', async () => {
  const { tools } = capture('all', 'exec', {
    '/databases/00000000-0000-0000-0000-000000000001/connection': { password: 'hunter2' }
  });
  for (const name of [
    'get_database_connection',
    'create_deploy_webhook_token',
    'create_notification_channel',
    'get_ingress_protection',
    'exec_in_pod'
  ]) {
    const { config } = tools.get(name)!;
    assert.equal(config._meta?.[SENSITIVE_META_KEY], true, name);
    assert.ok(config.description.endsWith('[sensitive]'), name);
  }
  const result = await tools
    .get('get_database_connection')!
    .handler({ databaseId: '00000000-0000-0000-0000-000000000001' });
  assert.equal(result._meta[SENSITIVE_META_KEY], true);
  assert.equal(tools.get('get_deployment')!.config._meta, undefined);
});

test('default toolsets keep the listing small and always include core', () => {
  const all = capture('all').tools.size;
  const defaults = capture('').tools;
  assert.deepEqual(DEFAULT_TOOLSETS, ['core', 'deployments', 'logs', 'env']);
  assert.ok(defaults.size < all, 'defaults list fewer tools than all');
  assert.ok(defaults.has('find') && defaults.has('get_deployment_rollout'));
  assert.ok(!defaults.has('create_database') && !defaults.has('delete_project'));
  const dbOnly = capture('databases').tools;
  assert.ok(dbOnly.has('get_database_connection') && dbOnly.has('find'));
  assert.ok(!dbOnly.has('restart_deployment'));
});

test('parseToolsets understands all, default and graft ids', () => {
  const all = parseToolsets('all');
  assert.equal(all.allGrafts, true);
  const mixed = parseToolsets('default, databases,greenhouse');
  assert.ok(mixed.toolsets.has('databases') && mixed.toolsets.has('logs'));
  assert.ok(mixed.grafts.has('greenhouse'));
  assert.equal(mixed.allGrafts, false);
});

test('session scope hides tools the connection cannot run', () => {
  const read = capture('all', 'read').tools;
  assert.ok(read.has('get_deployment'));
  assert.ok(!read.has('restart_deployment'));
  assert.ok(!read.has('validate_dns'), 'POST-backed reads need deploy');
  const deploy = capture('all', 'deploy').tools;
  assert.ok(deploy.has('restart_deployment'));
  assert.ok(!deploy.has('exec_in_pod'));
  assert.ok(capture('all', 'exec').tools.has('exec_in_pod'));
});

test('path params are encoded and query strings are built from defined values only', async () => {
  assert.equal(path`/pods/${'a/b?c'}/logs`, '/pods/a%2Fb%3Fc/logs');
  assert.equal(query({ a: 'x y', b: undefined, c: null, d: '', e: 0 }), '?a=x+y&e=0');
  assert.equal(query({}), '');

  const { tools, calls } = capture();
  await tools.get('get_pod_logs')!.handler({ podName: 'web/../x', namespace: 'ns', tailLines: 5 });
  assert.equal(calls.at(-1)!.path, '/pods/web%2F..%2Fx/logs?namespace=ns&tailLines=5');
  await tools.get('get_killed_container_logs')!.handler({
    deploymentId: 'd1',
    entryId: 'pod:container#1'
  });
  assert.equal(calls.at(-1)!.path, '/deployments/d1/killed-containers/pod%3Acontainer%231/logs');
});

test('id inputs are validated as uuids', () => {
  const { tools } = capture();
  const schema = z.object(tools.get('get_deployment')!.config.inputSchema);
  assert.equal(schema.safeParse({ deploymentId: 'not-a-uuid' }).success, false);
  assert.equal(
    schema.safeParse({ deploymentId: '3f1c2a4e-1111-4222-8333-444455556666' }).success,
    true
  );
});

test('list tools page client-side and report total and nextCursor', async () => {
  const deployments = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}` }));
  const { tools } = capture('all', 'exec', { '/deployments': deployments });
  const first = await tools.get('list_deployments')!.handler({ limit: 3 });
  assert.deepEqual(
    first.structuredContent.items.map((d: any) => d.id),
    ['d0', 'd1', 'd2']
  );
  assert.equal(first.structuredContent.total, 7);
  assert.equal(first.structuredContent.nextCursor, '3');
  const last = await tools.get('list_deployments')!.handler({ limit: 3, cursor: '6' });
  assert.deepEqual(
    last.structuredContent.items.map((d: any) => d.id),
    ['d6']
  );
  assert.equal(last.structuredContent.nextCursor, undefined);
  assert.deepEqual(JSON.parse(last.content[0].text), last.structuredContent);
});

test('core read tools declare an output schema their results satisfy', async () => {
  const { tools } = capture('all', 'exec', {
    '/deployments/d1': { id: 'd1', name: 'web', status: 'running' },
    '/deployments/d1/rollout': { phase: 'live', terminal: true, url: 'https://x' },
    '/projects': [{ id: 'p1' }]
  });
  for (const [name, args] of [
    ['get_deployment', { deploymentId: 'd1' }],
    ['get_deployment_rollout', { deploymentId: 'd1' }],
    ['list_projects', {}],
    ['find', { kinds: ['project'] }]
  ] as const) {
    const { config, handler } = tools.get(name)!;
    assert.ok(config.outputSchema, `${name} has an outputSchema`);
    const result = await handler(args);
    assert.equal(config.outputSchema.safeParse(result.structuredContent).success, true, name);
  }
});

test('find reports the kinds it could not load instead of hiding them', async () => {
  const tools = new Map<string, Captured>();
  const raw = {
    registerTool: (n: string, c: any, h: any) => tools.set(n, { config: c, handler: h })
  };
  const client = {
    get: async (p: string) => {
      if (p.startsWith('/databases')) throw new Error('Orchard API error (500): boom');
      return [];
    }
  };
  registerQueryTools(
    catalogServer(raw, { selection: parseToolsets('all'), scope: 'exec' }) as any,
    client as any
  );
  const result = await tools.get('find')!.handler({});
  assert.equal(result.structuredContent.partial, true);
  assert.deepEqual(result.structuredContent.errors, [
    { kind: 'database', error: 'Orchard API error (500): boom' }
  ]);
});

test('rollout, build runs, releases and rollback hit the right routes', async () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }));
  const { tools, calls } = capture('all', 'exec', {
    '/deployments/d1/build-runs?limit=3': runs.slice(0, 3)
  });
  await tools
    .get('get_deployment_rollout')!
    .handler({ deploymentId: 'd1', wait: true, timeout: 30, release: 'rel-1' });
  assert.equal(calls.at(-1)!.path, '/deployments/d1/rollout?wait=1&timeout=30&release=rel-1');
  const page = await tools.get('list_build_runs')!.handler({ deploymentId: 'd1', limit: 2 });
  assert.equal(calls.at(-1)!.path, '/deployments/d1/build-runs?limit=3');
  const body = JSON.parse(page.content[0].text);
  assert.deepEqual(
    body.items.map((r: any) => r.id),
    ['r0', 'r1']
  );
  assert.equal(body.nextCursor, '2');
  await tools.get('list_releases')!.handler({ deploymentId: 'd1' });
  assert.equal(calls.at(-1)!.path, '/deployments/d1/releases?limit=21');
  await tools.get('rollback_to_previous')!.handler({ deploymentId: 'd1' });
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: '/deployments/d1/rollback',
    body: undefined
  });
  await tools.get('redeploy_compose_stack')!.handler({ stackId: 's1' });
  assert.equal(calls.at(-1)!.path, '/compose-stacks/s1/redeploy');
});

test('job run logs and exec output are capped at 20k characters', async () => {
  const big = 'x'.repeat(50_000);
  const { tools } = capture('all', 'exec', {
    '/job-runs/r1/steps/1/logs': { logs: big },
    '/pods/p1/exec': { stdout: big, stderr: 'oops', exitCode: 0 }
  });
  const logs = JSON.parse(
    (await tools.get('get_job_run_logs')!.handler({ runId: 'r1', stepOrder: 1 })).content[0].text
  );
  assert.equal(logs.truncated, true);
  assert.ok(logs.logs.length < 20_200 && logs.logs.startsWith('[truncated'));
  const exec = JSON.parse(
    (
      await tools
        .get('exec_in_pod')!
        .handler({ podName: 'p1', namespace: 'ns', command: 'cat /big' })
    ).content[0].text
  );
  assert.equal(exec.stdoutTruncated, true);
  assert.equal(exec.stderr, 'oops');
  assert.ok(exec.stdout.length < 20_200);
});

test('delete_ingress without a parent id is an error result', async () => {
  const { tools } = capture();
  const result = await tools.get('delete_ingress')!.handler({ ingressId: 'i1' });
  assert.equal(result.isError, true);
});

test('job steps accept a secret flag on env vars', () => {
  const { tools } = capture();
  const steps = tools.get('replace_job_steps')!.config.inputSchema.steps;
  const parsed = steps.parse([
    { type: 'image', image: 'alpine', envVars: [{ key: 'TOKEN', value: 'x', secret: true }] }
  ]);
  assert.equal(parsed[0].envVars[0].secret, true);
});

test('no tool description points at a tool that does not exist', () => {
  const { tools } = capture();
  const names = new Set(tools.keys());
  for (const [name, { config }] of tools) {
    for (const ref of String(config.description).match(/\b[a-z]+(?:_[a-z]+){1,5}\b/g) ?? []) {
      if (/^(list|get|create|update|delete|set|add|deploy|run|cancel)_/.test(ref)) {
        assert.ok(names.has(ref), `${name} mentions ${ref}`);
      }
    }
  }
});

test('docs are exposed as resources and llms.txt degrades to a pointer', async () => {
  const resources = new Map<string, any>();
  registerDocResources({
    registerResource: (name: string, uri: string, config: any, read: any) =>
      resources.set(uri, { name, config, read })
  } as any);
  const guide = resources.get('orchard://docs/template-yaml-guide');
  const read = await guide.read(new URL('orchard://docs/template-yaml-guide'));
  assert.match(read.contents[0].text, /apiVersion: leaf\/v1/);
  assert.ok(resources.has('orchard://docs/llms.txt'));
  const offline = await fetchLlmsTxt((async () => {
    throw new Error('offline');
  }) as any);
  assert.match(offline, /Read it directly at https:\/\//);
});
