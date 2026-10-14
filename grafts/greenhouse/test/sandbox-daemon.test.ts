import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import {
  SandboxRunnerRegistry,
  devShellScript
} from '../server/src/sandboxes/runners/sandbox-runner.registry';
import {
  SandboxDaemonService,
  daemonUrl
} from '../server/src/sandboxes/daemon/sandbox-daemon.service';
import {
  SandboxAgentHostService,
  mergeActivity
} from '../server/src/sandboxes/daemon/sandbox-agent-host.service';

const REF = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u',
  runner: 'kubernetes' as const,
  podName: 'sbx',
  namespace: null,
  externalId: null,
  runnerState: null
};

const cleanups: (() => void)[] = [];
test.afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

type Handler = (method: string, params: any, notify: (m: string, p: unknown) => void) => unknown;

async function fakeDaemon(handler: Handler, token = 'tok') {
  const wss = new WebSocketServer({ port: 0 });
  const seen: { method: string; params: any }[] = [];
  const auth: (string | undefined)[] = [];
  wss.on('connection', (ws, req) => {
    auth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${token}`) {
      ws.close();
      return;
    }
    const notify = (method: string, params: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push({ method: msg.method, params: msg.params });
      try {
        const result =
          msg.method === 'initialize'
            ? { version: '1' }
            : await handler(msg.method, msg.params, notify);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e: any) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: e.code ?? -32603, message: e.message }
          })
        );
      }
    });
  });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    port,
    seen,
    auth,
    close: () => {
      for (const client of wss.clients) client.terminate();
      return new Promise((r) => wss.close(r));
    }
  };
}

function harness(port: number | null, token = 'tok') {
  const execs: string[][] = [];
  const runner: any = {
    id: 'kubernetes',
    label: 'k8s',
    cache: 0,
    async exec(_ref: unknown, command: string[]) {
      execs.push(command);
      return { stdout: 'from-runner', stderr: '', exitCode: 0, ok: true };
    },
    async httpTarget() {
      if (port === null) throw new Error('no address');
      return { kind: 'url', baseUrl: `http://127.0.0.1:${port}`, headers: {} };
    },
    bump() {
      this.cache += 1;
      return this.cache;
    }
  };
  const config: any = { flag: () => true, value: () => null };
  const registry = new SandboxRunnerRegistry([runner], config);
  const secrets: any = { boxSecret: async () => token };
  const daemon = new SandboxDaemonService(registry, secrets);
  cleanups.push(() => daemon.onModuleDestroy());
  return { registry, daemon, runner, execs };
}

test('only plain dev shell scripts without extra env are eligible for the daemon', () => {
  assert.equal(devShellScript(['su', '-l', 'dev', '-c', 'echo hi']), 'echo hi');
  assert.equal(devShellScript(['su', '-l', 'dev', '-c', 'echo hi'], { env: { A: '1' } }), null);
  assert.equal(devShellScript(['su', '-l', 'root', '-c', 'x']), null);
  assert.equal(devShellScript(['bash', '-c', 'x']), null);
  assert.equal(devShellScript(['su', '-l', 'dev', '-c', 'x', 'extra']), null);
  assert.equal(daemonUrl('http://10.0.0.4:4097'), 'ws://10.0.0.4:4097/rpc');
  assert.equal(daemonUrl('https://sbx-4097.vercel.run/'), 'wss://sbx-4097.vercel.run/rpc');
});

test('dev shell scripts go through the daemon, everything else stays on the runner', async () => {
  const fake = await fakeDaemon((method, params) => {
    if (method === 'exec.script') {
      return {
        stdout: `daemon:${params.script}:${Buffer.from(params.stdin ?? '', 'base64').toString()}`,
        stderr: '',
        exitCode: 0,
        ok: true
      };
    }
    throw Object.assign(new Error('nope'), { code: -32601 });
  });
  try {
    const { registry, execs, runner } = harness(fake.port);
    const routed = registry.for(REF);
    const res = await routed.exec(REF, ['su', '-l', 'dev', '-c', 'git status'], {
      stdin: Buffer.from('in'),
      timeoutMs: 1234
    });
    assert.equal(res.stdout, 'daemon:git status:in');
    assert.equal(fake.auth[0], 'Bearer tok');
    const call = fake.seen.find((s) => s.method === 'exec.script')!;
    assert.equal(call.params.timeoutMs, 1234);
    const root = await routed.exec(REF, ['cat', '/etc/hostname']);
    assert.equal(root.stdout, 'from-runner');
    assert.deepEqual(execs, [['cat', '/etc/hostname']]);
    assert.equal((routed as any).bump(), 1);
    assert.equal(runner.cache, 1, 'methods run against the real runner, not a copy');
    await routed.exec(REF, ['su', '-l', 'dev', '-c', 'true']);
    assert.equal(fake.auth.length, 1, 'one pooled connection per machine');
  } finally {
    await fake.close();
  }
});

test('when the daemon is unreachable the runner exec still works and the miss is remembered', async () => {
  const { registry, execs, daemon } = harness(1);
  const routed = registry.for(REF);
  const res = await routed.exec(REF, ['su', '-l', 'dev', '-c', 'echo hi']);
  assert.equal(res.stdout, 'from-runner');
  const started = Date.now();
  await routed.exec(REF, ['su', '-l', 'dev', '-c', 'echo again']);
  assert.ok(Date.now() - started < 200, 'a known miss does not dial again');
  assert.equal(execs.length, 2);
  assert.equal(await daemon.available(REF), false);
});

test('a wrong daemon token falls back instead of failing the command', async () => {
  const fake = await fakeDaemon(() => ({}), 'right');
  try {
    const { registry, execs } = harness(fake.port, 'wrong');
    const res = await registry.for(REF).exec(REF, ['su', '-l', 'dev', '-c', 'echo hi']);
    assert.equal(res.stdout, 'from-runner');
    assert.equal(execs.length, 1);
  } finally {
    await fake.close();
  }
});

test('a daemon timeout surfaces as the same error the runners raise', async () => {
  const fake = await fakeDaemon((method) => {
    if (method === 'exec.script')
      throw Object.assign(new Error('sandbox command timed out'), { code: -32603 });
    return {};
  });
  try {
    const { registry } = harness(fake.port);
    await assert.rejects(
      registry.for(REF).exec(REF, ['su', '-l', 'dev', '-c', 'sleep 9'], { timeoutMs: 10 }),
      /sandbox command timed out/
    );
  } finally {
    await fake.close();
  }
});

test('a chat stream replays history then forwards live events once, in order', async () => {
  let notify: ((m: string, p: unknown) => void) | null = null;
  const fake = await fakeDaemon((method, params, n) => {
    notify = n;
    if (method === 'chat.subscribe') {
      n('chat.event', { seq: 3, chatId: params.chatId, kind: 'update', ts: 0 });
      return {
        events: [
          { seq: 2, chatId: params.chatId, kind: 'prompt', ts: 0 },
          { seq: 3, chatId: params.chatId, kind: 'update', ts: 0 }
        ],
        lastSeq: 3
      };
    }
    return {};
  });
  try {
    const { daemon } = harness(fake.port);
    const chatId = 'acp_000000000000000000000000';
    const prisma: any = {
      sandboxChat: { findFirst: async () => ({ id: chatId }) }
    };
    const host = new SandboxAgentHostService(prisma, daemon);
    const sent: number[] = [];
    const controller = new AbortController();
    await host.stream(
      { ...REF, status: 'running', repoUrl: null },
      'sid',
      chatId,
      1,
      (ev) => sent.push(ev.seq),
      controller.signal
    );
    notify!('chat.event', { seq: 3, chatId, kind: 'update', ts: 0 });
    notify!('chat.event', { seq: 4, chatId, kind: 'turn.end', ts: 0 });
    notify!('chat.event', { seq: 9, chatId: 'acp_other0000000000000000000', kind: 'x', ts: 0 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sent, [2, 3, 4]);
    controller.abort();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(fake.seen.some((s) => s.method === 'chat.unsubscribe'));
  } finally {
    await fake.close();
  }
});

test('the busiest chat decides a worktree activity', () => {
  assert.equal(mergeActivity('idle', 'working'), 'working');
  assert.equal(mergeActivity('needs_input', 'working'), 'needs_input');
  assert.equal(mergeActivity(undefined, 'idle'), 'idle');
});

const BIN = process.env.ORCHARD_AGENTD_BIN;

test('the real daemon binary runs scripts for the server', { skip: !BIN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentd-'));
  writeFileSync(join(dir, 'token'), 'real-token');
  mkdirSync(join(dir, 'state'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    BIN!,
    [
      'sandbox',
      'agentd',
      '--listen',
      `127.0.0.1:${port}`,
      '--token-file',
      join(dir, 'token'),
      '--state-dir',
      join(dir, 'state')
    ],
    { stdio: 'ignore' }
  );
  try {
    await new Promise((r) => setTimeout(r, 600));
    const { registry, execs, daemon } = harness(port, 'real-token');
    const res = await registry
      .for(REF)
      .exec(REF, ['su', '-l', 'dev', '-c', 'read x; echo "got $x"; exit 3'], {
        stdin: Buffer.from('hello\n')
      });
    assert.equal(res.stdout.trim(), 'got hello');
    assert.equal(res.exitCode, 3);
    assert.equal(res.ok, false);
    assert.equal(execs.length, 0);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const catalog = await daemon.call<any>(REF, 'agent.catalog', {});
    assert.ok(Array.isArray(catalog.agents));
  } finally {
    child.kill();
  }
});

test('an ACP event log reads back as a prompt and reply transcript', async () => {
  const { acpTranscript } =
    await import('../server/src/sandboxes/daemon/sandbox-agent-host.service');
  const ev = (seq: number, kind: string, data: unknown, author?: any) => ({
    seq,
    ts: 1_700_000_000_000 + seq,
    chatId: 'acp_x',
    kind,
    data,
    author
  });
  const messages = acpTranscript(
    [
      ev(1, 'created', {}),
      ev(
        2,
        'prompt',
        { messageId: 'msg_a', prompt: [{ type: 'text', text: 'fix it' }] },
        { id: 'u1', name: 'Ada' }
      ),
      ev(3, 'turn.start', null),
      ev(4, 'update', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'On ' }
      }),
      ev(5, 'update', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'it.' }
      }),
      ev(6, 'update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit' }),
      ev(7, 'update', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done.' }
      }),
      ev(8, 'update', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'hmm' }
      }),
      ev(9, 'turn.end', { stopReason: 'end_turn' })
    ] as any,
    10
  );
  assert.deepEqual(
    messages.map((m) => [m.role, m.text, m.author?.name ?? null]),
    [
      ['user', 'fix it', 'Ada'],
      ['assistant', 'On it.', null],
      ['assistant', 'Done.', null]
    ]
  );
  assert.equal(messages[0].id, 'msg_a');
  assert.equal(acpTranscript([], 5).length, 0);
});
