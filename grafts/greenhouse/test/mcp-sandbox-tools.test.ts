import './support';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSandboxTools } from '../mcp/src/tools';
import type {
  SandboxMinRole,
  SandboxRoleOptions
} from '../server/src/sandboxes/sandbox-access.service';
import { sandboxRoleAllows } from '../server/src/sandboxes/sandbox-access.service';
import { SandboxesController } from '../server/src/sandboxes/sandboxes.controller';
import { SandboxSessionsController } from '../server/src/sandboxes/sandbox-sessions.controller';
import { SandboxAgentController } from '../server/src/sandboxes/sandbox-agent.controller';

const SBX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

interface Call {
  method: string;
  path: string;
  body?: any;
}

function harness() {
  const tools = new Map<string, { config: any; handler: any }>();
  const server = {
    registerTool: (name: string, config: any, handler: any) => {
      tools.set(name, { config, handler });
    }
  };
  const calls: Call[] = [];
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return { ok: true };
    },
    post: async (path: string, body?: any) => {
      calls.push({ method: 'POST', path, body });
      return { ok: true };
    },
    put: async () => {
      throw new Error('sandbox tools never PUT');
    },
    patch: async () => {
      throw new Error('sandbox tools never PATCH');
    },
    delete: async () => {
      throw new Error('sandbox tools never DELETE');
    }
  };
  registerSandboxTools(server as any, client as any);
  return { tools, calls };
}

async function run(name: string, args: Record<string, unknown>) {
  const { tools, calls } = harness();
  const tool = tools.get(name);
  assert.ok(tool, `${name} is registered`);
  await tool.handler(args);
  return calls;
}

test('every requested Greenhouse tool is registered with the right hints', () => {
  const { tools } = harness();
  const expected: Record<string, boolean> = {
    list_sandboxes: true,
    get_sandbox: true,
    start_sandbox: false,
    stop_sandbox: false,
    list_sandbox_sessions: true,
    create_sandbox_session: false,
    prompt_sandbox_session: false,
    get_sandbox_session_diff: true,
    get_sandbox_session_transcript: true,
    create_sandbox_session_pr: false
  };
  assert.deepEqual([...tools.keys()].sort(), Object.keys(expected).sort());
  for (const [name, readOnly] of Object.entries(expected)) {
    assert.equal(tools.get(name)!.config.annotations.readOnlyHint, readOnly, name);
  }
  assert.equal(tools.get('stop_sandbox')!.config.annotations.destructiveHint, true);
});

test('ids are validated before any request is made', () => {
  const { tools } = harness();
  const schema = tools.get('prompt_sandbox_session')!.config.inputSchema;
  assert.equal(schema.sandboxId.safeParse('../../admin').success, false);
  assert.equal(schema.sessionId.safeParse('x/../y').success, false);
  assert.equal(schema.text.safeParse('').success, false);
  assert.equal(schema.sandboxId.safeParse(SBX).success, true);
});

test('each tool calls exactly the REST route the web app uses', async () => {
  assert.deepEqual(await run('list_sandboxes', {}), [{ method: 'GET', path: '/sandboxes' }]);
  assert.deepEqual(await run('list_sandboxes', { organizationId: SBX }), [
    { method: 'GET', path: `/sandboxes?organizationId=${SBX}` }
  ]);
  assert.deepEqual(await run('get_sandbox', { sandboxId: SBX }), [
    { method: 'GET', path: `/sandboxes/${SBX}` }
  ]);
  assert.deepEqual(await run('start_sandbox', { sandboxId: SBX }), [
    { method: 'POST', path: `/sandboxes/${SBX}/start`, body: undefined }
  ]);
  assert.deepEqual(await run('stop_sandbox', { sandboxId: SBX }), [
    { method: 'POST', path: `/sandboxes/${SBX}/stop`, body: undefined }
  ]);
  assert.deepEqual(await run('list_sandbox_sessions', { sandboxId: SBX, includeArchived: true }), [
    { method: 'GET', path: `/sandboxes/${SBX}/sessions?includeArchived=1` }
  ]);
  assert.deepEqual(await run('create_sandbox_session', { sandboxId: SBX, repo: 'app' }), [
    { method: 'POST', path: `/sandboxes/${SBX}/sessions`, body: { repo: 'app' } }
  ]);
  assert.deepEqual(
    await run('prompt_sandbox_session', { sandboxId: SBX, sessionId: SID, text: 'go' }),
    [{ method: 'POST', path: `/sandboxes/${SBX}/sessions/${SID}/prompt`, body: { text: 'go' } }]
  );
  assert.deepEqual(
    await run('get_sandbox_session_diff', { sandboxId: SBX, sessionId: SID, file: 'a b.ts' }),
    [
      { method: 'GET', path: `/sandboxes/${SBX}/changes?session=${SID}` },
      { method: 'GET', path: `/sandboxes/${SBX}/diff?session=${SID}&file=a%20b.ts` }
    ]
  );
  assert.deepEqual(
    await run('get_sandbox_session_transcript', { sandboxId: SBX, sessionId: SID, limit: 5 }),
    [{ method: 'GET', path: `/sandboxes/${SBX}/sessions/${SID}/transcript?limit=5` }]
  );
  assert.deepEqual(
    await run('create_sandbox_session_pr', { sandboxId: SBX, sessionId: SID, title: 'Fix' }),
    [{ method: 'POST', path: `/sandboxes/${SBX}/git/pr`, body: { session: SID, title: 'Fix' } }]
  );
});

test('a first prompt rides in the session body so it cannot race the session being prepared', async () => {
  const calls: Call[] = [];
  const handlers = new Map<string, any>();
  const client = {
    get: async () => ({}),
    post: async (path: string, body?: any) => {
      calls.push({ method: 'POST', path, body });
      return { id: SID, slug: 'fix', activity: 'working' };
    }
  };
  registerSandboxTools(
    { registerTool: (n: string, _c: any, h: any) => handlers.set(n, h) } as any,
    client as any
  );
  const out = await handlers.get('create_sandbox_session')({
    sandboxId: SBX,
    repo: 'app',
    prompt: 'fix it'
  });
  assert.deepEqual(calls, [
    { method: 'POST', path: `/sandboxes/${SBX}/sessions`, body: { repo: 'app', prompt: 'fix it' } }
  ]);
  assert.match(out.content[0].text, /working/);
});

test('no tool reaches the raw opencode proxy, a terminal or another tenant surface', async () => {
  const { tools } = harness();
  const args: Record<string, Record<string, unknown>> = {
    create_sandbox_session_pr: { title: 't' },
    prompt_sandbox_session: { text: 't' },
    create_sandbox_session: { repo: 'r' }
  };
  for (const [name, tool] of tools) {
    const calls: Call[] = [];
    const client = {
      get: async (path: string) => calls.push({ method: 'GET', path }),
      post: async (path: string, body?: any) => calls.push({ method: 'POST', path, body })
    };
    const local = new Map<string, any>();
    registerSandboxTools(
      { registerTool: (n: string, _c: any, h: any) => local.set(n, h) } as any,
      client as any
    );
    await local.get(name)({ sandboxId: SBX, sessionId: SID, ...(args[name] ?? {}) });
    for (const call of calls) {
      assert.match(call.path, /^\/sandboxes(\/|\?|$)/, `${name} stays under /sandboxes`);
      assert.doesNotMatch(call.path, /opencode|terminal|ssh|live|members|credentials/, name);
    }
    assert.ok(tool);
  }
});

const SENTINEL = new Error('gate');

function recorder() {
  const gates: Array<{ min: SandboxMinRole; orgAdmin?: boolean }> = [];
  const access = {
    async requireSandboxRole(
      _id: string,
      _u: string,
      min: SandboxMinRole,
      o: SandboxRoleOptions = {}
    ) {
      gates.push({ min, ...(o.orgAdmin ? { orgAdmin: true } : {}) });
      throw SENTINEL;
    }
  };
  const users = {
    async findOrCreateByClerkId() {
      return { id: 'mcp-user', email: 'mcp@example.com', username: 'mcp', githubAccessToken: null };
    }
  };
  return { gates, access, users, analytics: { configured: false } };
}

async function gate(fn: () => Promise<unknown>, gates: any[]) {
  gates.length = 0;
  await fn().catch((e) => {
    if (e !== SENTINEL) throw e;
  });
  return gates[0];
}

test('the REST routes behind the tools enforce the Host/Guest matrix for MCP callers too', async () => {
  const r = recorder();
  const any = undefined as any;
  const req = { user: { sub: 'mcp-user', viaMcpGateway: true }, query: {}, body: {} };
  const sandboxes = new SandboxesController(
    any,
    any,
    any,
    any,
    r.users as any,
    r.analytics as any,
    any,
    any,
    r.access as any,
    any
  );
  const sessions = new SandboxSessionsController(
    r.access as any,
    any,
    any,
    r.users as any,
    r.analytics as any,
    any
  );
  const agent = new SandboxAgentController(
    r.access as any,
    any,
    r.users as any,
    r.analytics as any,
    any
  );
  const byTool: Record<
    string,
    [() => Promise<unknown>, { min: SandboxMinRole; orgAdmin?: boolean }]
  > = {
    get_sandbox: [() => sandboxes.get(req, SBX), { min: 'viewer', orgAdmin: true }],
    start_sandbox: [() => sandboxes.start(req, SBX), { min: 'collaborator', orgAdmin: true }],
    stop_sandbox: [() => sandboxes.stop(req, SBX), { min: 'owner', orgAdmin: true }],
    list_sandbox_sessions: [() => sessions.list(req, SBX), { min: 'viewer' }],
    create_sandbox_session: [() => sessions.create(req, SBX, {}), { min: 'collaborator' }],
    prompt_sandbox_session: [() => agent.prompt(req, SBX, SID, {}), { min: 'collaborator' }],
    get_sandbox_session_diff: [() => sandboxes.diff(req, SBX), { min: 'viewer' }],
    get_sandbox_session_transcript: [() => agent.transcript(req, SBX, SID), { min: 'viewer' }],
    create_sandbox_session_pr: [() => sandboxes.gitPr(req, SBX, {}), { min: 'collaborator' }]
  };
  for (const [tool, [fn, expected]] of Object.entries(byTool)) {
    assert.deepEqual(await gate(fn, r.gates), expected, tool);
  }
  const viewer = { role: 'viewer' as const, orgAdmin: false };
  const guest = { role: 'collaborator' as const, orgAdmin: false };
  assert.equal(sandboxRoleAllows(viewer, 'collaborator'), false, 'a viewer cannot prompt');
  assert.equal(sandboxRoleAllows(guest, 'collaborator'), true, 'a guest can prompt');
  assert.equal(sandboxRoleAllows(guest, 'collaborator'), true, 'a guest opens a PR as themselves');
  assert.equal(sandboxRoleAllows(viewer, 'collaborator'), false, 'a viewer cannot open a PR');
});
