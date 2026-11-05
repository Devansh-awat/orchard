import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { registerConfigurationTools } from '../src/mcp/tools/configuration';
import { registerEnvironmentTools } from '../src/mcp/tools/environments';
import { registerQueryTools } from '../src/mcp/tools/query';
import { json } from '../src/mcp/tools/reply';
import { catalogServer, parseToolsets } from '../src/mcp/catalog';

interface Call {
  method: string;
  path: string;
  body?: any;
}

function harness(
  register: (server: any, client: any) => void,
  responses: Record<string, any> = {}
) {
  const tools = new Map<string, { config: any; handler: any }>();
  const server = {
    registerTool: (name: string, config: any, handler: any) => {
      tools.set(name, { config, handler });
    }
  };
  const calls: Call[] = [];
  const respond = (path: string) => responses[path] ?? {};
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return respond(path);
    },
    post: async (path: string, body?: any) => {
      calls.push({ method: 'POST', path, body });
      return respond(path);
    },
    put: async (path: string, body?: any) => {
      calls.push({ method: 'PUT', path, body });
      return respond(path);
    },
    patch: async (path: string, body?: any) => {
      calls.push({ method: 'PATCH', path, body });
      return respond(path);
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
      return respond(path);
    }
  };
  register(
    catalogServer(server, { selection: parseToolsets('all'), scope: 'exec' }) as any,
    client as any
  );
  return { tools, calls };
}

test('add_env_vars keeps untouched vars and carries secrets through as null', async () => {
  const { tools, calls } = harness(registerConfigurationTools, {
    '/deployments/d1': {
      envVars: [
        { key: 'PORT', value: '3000', secret: false },
        { key: 'API_KEY', value: null, secret: true }
      ]
    }
  });

  await tools.get('add_env_vars')!.handler({
    deploymentId: 'd1',
    envVars: [{ key: 'PORT', value: '8080' }]
  });

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, '/deployments/d1/env');
  assert.deepEqual(put.body.env, [
    { key: 'API_KEY', value: null, secret: true },
    { key: 'PORT', value: '8080' }
  ]);
});

test('set_env_vars accepts a null value so a secret survives a full replace', () => {
  const { tools } = harness(registerConfigurationTools);
  const schema = tools.get('set_env_vars')!.config.inputSchema;
  const parsed = schema.envVars.parse([{ key: 'API_KEY', value: null, secret: true }]);
  assert.deepEqual(parsed, [{ key: 'API_KEY', value: null, secret: true }]);
});

test('set_env_vars is annotated destructive so clients gate on it', () => {
  const { tools } = harness(registerConfigurationTools);
  assert.equal(tools.get('set_env_vars')!.config.annotations.destructiveHint, true);
  assert.equal(tools.get('add_env_vars')!.config.annotations.destructiveHint, false);
});

test('update_deployment_health_check merges one field into the stored config', async () => {
  const { tools, calls } = harness(registerConfigurationTools, {
    '/deployments/d1': {
      healthCheckEnabled: true,
      healthCheckType: 'http',
      healthCheckPath: '/healthz',
      healthCheckPort: 8080,
      healthCheckCommand: null,
      livenessEnabled: false,
      readinessEnabled: true,
      startupEnabled: true,
      healthCheckInterval: 15,
      healthCheckTimeout: 2,
      healthCheckRetries: 5,
      startupFailureThreshold: 60,
      healthCheckOverride: true
    }
  });

  await tools.get('update_deployment_health_check')!.handler({
    deploymentId: 'd1',
    livenessEnabled: true
  });

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, '/deployments/d1/health-check');
  assert.deepEqual(put.body, {
    healthCheckEnabled: true,
    healthCheckType: 'http',
    healthCheckPath: '/healthz',
    healthCheckPort: 8080,
    healthCheckCommand: null,
    livenessEnabled: true,
    readinessEnabled: true,
    startupEnabled: true,
    healthCheckInterval: 15,
    healthCheckTimeout: 2,
    healthCheckRetries: 5,
    startupFailureThreshold: 60,
    healthCheckOverride: true
  });
});

test('update_deployment_health_check falls back to defaults for unset stored fields', async () => {
  const { tools, calls } = harness(registerConfigurationTools, { '/deployments/d1': {} });

  await tools.get('update_deployment_health_check')!.handler({
    deploymentId: 'd1',
    healthCheckEnabled: true,
    healthCheckPath: '/health'
  });

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.deepEqual(put.body, {
    healthCheckEnabled: true,
    healthCheckType: 'http',
    healthCheckPath: '/health',
    healthCheckPort: null,
    healthCheckCommand: null,
    livenessEnabled: true,
    readinessEnabled: true,
    startupEnabled: false,
    healthCheckInterval: 30,
    healthCheckTimeout: 5,
    healthCheckRetries: 3,
    startupFailureThreshold: 30,
    healthCheckOverride: false
  });
});

test('add_shared_env_vars merges against the current shared set', async () => {
  const { tools, calls } = harness(registerEnvironmentTools, {
    '/environments/e1/shared-vars': [
      { key: 'SENTRY_DSN', value: 'https://x', secret: false },
      { key: 'STRIPE_KEY', value: null, secret: true }
    ]
  });

  await tools.get('add_shared_env_vars')!.handler({
    environmentId: 'e1',
    vars: [{ key: 'SENTRY_DSN', value: 'https://y' }]
  });

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, '/environments/e1/shared-vars');
  assert.deepEqual(put.body.vars, [
    { key: 'STRIPE_KEY', value: null, secret: true },
    { key: 'SENTRY_DSN', value: 'https://y' }
  ]);
});

test('delete_shared_env_vars drops only the named keys and reports misses', async () => {
  const { tools, calls } = harness(registerEnvironmentTools, {
    '/environments/e1/shared-vars': [
      { key: 'A', value: '1', secret: false },
      { key: 'B', value: '2', secret: false }
    ]
  });

  const res = await tools.get('delete_shared_env_vars')!.handler({
    environmentId: 'e1',
    keys: ['B', 'NOPE']
  });

  const put = calls.find((c) => c.method === 'PUT')!;
  assert.deepEqual(put.body.vars, [{ key: 'A', value: '1', secret: false }]);
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.removed, ['B']);
  assert.deepEqual(payload.notFound, ['NOPE']);
});

test('get_deployment omits the build log so it cannot flood the caller', async () => {
  const { tools } = harness(registerQueryTools, {
    '/deployments/d1': { id: 'd1', name: 'web', buildLogs: 'x'.repeat(5000) }
  });

  const res = await tools.get('get_deployment')!.handler({ deploymentId: 'd1' });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.name, 'web');
  assert.equal(payload.buildLogs, '<omitted, call get_build_logs>');
});

test('get_deployment names env vars and leaves their values out', async () => {
  const { tools } = harness(registerQueryTools, {
    '/deployments/d1': {
      id: 'd1',
      replicas: 1,
      envVars: [{ key: 'DATABASE_URL', value: 'postgres://x', secret: false }],
      imageHistory: [{ replicas: 1, envSnapshot: [{ key: 'OLD', value: 'postgres://x' }] }]
    }
  });

  const res = await tools.get('get_deployment')!.handler({ deploymentId: 'd1' });
  assert.equal(res.content[0].text.includes('postgres://x'), false);
  assert.deepEqual(JSON.parse(res.content[0].text).envVars, {
    names: ['DATABASE_URL'],
    values: '<omitted, call get_env_vars>'
  });
  assert.deepEqual(res.structuredContent.envVars.names, ['DATABASE_URL']);
  assert.deepEqual(res.structuredContent.imageHistory[0].envSnapshot.names, ['OLD']);
});

test('get_env_vars still returns the values', async () => {
  const envVars = [{ key: 'A', value: '1', secret: false }];
  const { tools } = harness(registerQueryTools, {
    '/deployments/d1': { id: 'd1', replicas: 1, envVars }
  });

  const res = await tools.get('get_env_vars')!.handler({ deploymentId: 'd1' });
  assert.deepEqual(JSON.parse(res.content[0].text), envVars);
});

test('a job step keeps its env vars, it has no other way to read them', () => {
  const step = { steps: [{ name: 'a', envVars: [{ key: 'A', value: '1' }] }] };
  assert.deepEqual(JSON.parse(json(step).content[0].text), step);
});

test('list_deployments goes cross-project when no projectId is given', async () => {
  const { tools, calls } = harness(registerQueryTools);

  await tools.get('list_deployments')!.handler({});
  await tools.get('list_deployments')!.handler({ organizationId: 'org-1' });
  await tools.get('list_deployments')!.handler({ projectId: 'p1', organizationId: 'org-1' });

  assert.deepEqual(
    calls.map((c) => c.path),
    ['/deployments', '/deployments?orgId=org-1', '/projects/p1/deployments']
  );
});

test('find resolves a name across kinds and returns the ids tools need', async () => {
  const { tools } = harness(registerQueryTools, {
    '/organizations/user': [{ id: 'o1', name: 'Hack Club', slug: 'hackclub' }],
    '/projects': [{ id: 'p1', name: 'Hackatime', slug: 'hackatime', organizationId: 'o1' }],
    '/deployments': [
      {
        id: 'd1',
        name: 'hackatime-web',
        status: 'running',
        githubRepo: 'hackclub/hackatime',
        ingresses: [{ host: 'hackatime.hackclub.com' }],
        services: [],
        project: { id: 'p1', name: 'Hackatime', organizationId: 'o1' }
      },
      {
        id: 'd2',
        name: 'unrelated',
        status: 'running',
        ingresses: [],
        services: [],
        project: { id: 'p2', name: 'Other', organizationId: 'o1' }
      }
    ],
    '/databases': []
  });

  const res = await tools.get('find')!.handler({ query: 'hackatime' });
  const { results } = JSON.parse(res.content[0].text);

  assert.deepEqual(
    results.map((r: any) => [r.kind, r.id]),
    [
      ['project', 'p1'],
      ['deployment', 'd1']
    ]
  );
  assert.deepEqual(results[1].hosts, ['hackatime.hackclub.com']);
  assert.equal(results[1].projectId, 'p1');
});

test('find can be narrowed to one kind and skips the other fetches', async () => {
  const { tools, calls } = harness(registerQueryTools, { '/databases': [] });

  await tools.get('find')!.handler({ query: 'x', kinds: ['database'] });

  assert.deepEqual(
    calls.map((c) => c.path),
    ['/databases']
  );
});

test('get_build_logs tails a long transcript and leads with the error', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `step ${i}`);
  const { tools } = harness(registerQueryTools, {
    '/deployments/d1/logs': {
      logs: lines.join('\n'),
      status: 'failed',
      buildError: 'npm ERR! missing script: build'
    }
  });

  const res = await tools.get('get_build_logs')!.handler({ deploymentId: 'd1' });
  const payload = JSON.parse(res.content[0].text);

  assert.equal(payload.buildError, 'npm ERR! missing script: build');
  assert.equal(payload.totalLines, 5000);
  assert.equal(payload.truncated, true);
  const returned = payload.logs.split('\n');
  assert.equal(returned.length, 400);
  assert.equal(returned.at(-1), 'step 4999');
});

test('get_build_logs returns everything when full is set or the log is short', async () => {
  const { tools } = harness(registerQueryTools, {
    '/deployments/d1/logs': { logs: 'a\nb\nc', status: 'success', buildError: null }
  });

  const short = JSON.parse(
    (await tools.get('get_build_logs')!.handler({ deploymentId: 'd1' })).content[0].text
  );
  assert.equal(short.truncated, undefined);
  assert.equal(short.logs, 'a\nb\nc');

  const { tools: t2 } = harness(registerQueryTools, {
    '/deployments/d1/logs': { logs: 'x\ny\nz', status: 'success' }
  });
  const full = JSON.parse(
    (await t2.get('get_build_logs')!.handler({ deploymentId: 'd1', full: true, tailLines: 1 }))
      .content[0].text
  );
  assert.equal(full.logs, 'x\ny\nz');
});

test('get_resource_quota reads the caller-scoped headroom endpoint', async () => {
  const { tools, calls } = harness(registerQueryTools, {
    '/organizations/o1/quota/me': { effectiveLimit: { cpuMilli: 2000, memoryBytes: 1 } }
  });
  await tools.get('get_resource_quota')!.handler({ organizationId: 'o1' });
  assert.deepEqual(calls, [{ method: 'GET', path: '/organizations/o1/quota/me' }]);
});

test('tool results are serialised compactly, and stay that way', async () => {
  const { tools } = harness(registerQueryTools, {
    '/organizations/user': [{ id: 'o1', name: 'Hack Club' }]
  });
  const out = (await tools.get('list_organizations')!.handler({})).content[0].text;
  assert.equal(out, '[{"id":"o1","name":"Hack Club"}]');
  assert.ok(!out.includes('\n'), 'no indentation in tool output');

  // Indenting responses costs ~23-34% more tokens for nothing, so every tool
  // goes through reply.ts. Catch a hand-rolled JSON.stringify creeping back in.
  const dir = new URL('../src/mcp/tools/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && f !== 'reply.ts');
  assert.ok(files.length > 5, 'found the tool files');
  for (const f of files) {
    const src = await readFile(new URL(f, dir), 'utf8');
    assert.ok(
      !src.includes('JSON.stringify'),
      `${f} should return through reply.ts json()/text(), not JSON.stringify`
    );
  }
});

test('env values and compose files stay out of every reply shape', () => {
  const res = json({
    pod: { spec: { containers: [{ env: [{ name: 'API_KEY', value: 'hunter2' }] }] } },
    release: { envSnapshot: [{ key: 'OLD', value: 'hunter2' }] },
    app: { replicas: 1, envVars: [{ key: 'TOKEN', value: 'hunter2' }] },
    stack: { composeYaml: 'password: hunter2' }
  });
  const body = res.content[0].text;
  assert.ok(!body.includes('hunter2'));
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.pod.spec.containers[0].env.names, ['API_KEY']);
  assert.deepEqual(parsed.release.envSnapshot.names, ['OLD']);
  assert.deepEqual(parsed.app.envVars.names, ['TOKEN']);
});
