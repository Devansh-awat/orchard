import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcpReducer,
  acpOptionValues,
  pickOption,
  toolShape,
  toolStatus,
  type AcpEvent
} from '../ui/src/components/sandbox/chat/acp-reducer';

const CWD = '/persist/home/.worktrees/app/pool-1a2b3c4d';

function run(events: Partial<AcpEvent>[]) {
  const target = { entries: [] as any[] };
  const r = new AcpReducer('acp_x', target, CWD);
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    r.apply({ seq, ts: 1000 * seq, chatId: 'acp_x', kind: 'update', ...ev } as AcpEvent);
  }
  return { r, entries: target.entries };
}

const upd = (data: Record<string, unknown>) => ({ kind: 'update', data });

test('a turn becomes a prompt, streamed text, tools and a result with the files it touched', () => {
  const { r, entries } = run([
    { kind: 'created', data: { title: 'Fix' } },
    {
      kind: 'prompt',
      data: { messageId: 'msg_1', prompt: [{ type: 'text', text: 'fix login' }] },
      author: { id: 'u1', name: 'Ada' }
    },
    { kind: 'checkpoint', data: { commit: 'a'.repeat(40) } },
    { kind: 'turn.start' },
    upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } }),
    upd({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'On ' }
    }),
    upd({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'it.' }
    }),
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit src/login.ts',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: `${CWD}/src/login.ts` }]
    }),
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'diff', path: `${CWD}/src/login.ts`, oldText: 'a\nb', newText: 'a\nc\nd' }]
    }),
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'pnpm test',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'pnpm test' }
    }),
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }]
    }),
    upd({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: { type: 'text', text: 'Done.' }
    }),
    { kind: 'turn.end', data: { stopReason: 'end_turn' } }
  ]);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['user', 'thinking', 'text', 'tool', 'tool', 'text', 'result']
  );
  assert.equal(entries[0].text, 'fix login');
  assert.equal(entries[0].author.name, 'Ada');
  assert.equal(entries[1].done, true);
  assert.equal(entries[2].text, 'On it.');
  assert.equal(entries[3].name, 'Edit');
  assert.equal(entries[3].summary, 'login.ts');
  assert.equal(entries[3].input.new_string, 'a\nc\nd');
  assert.deepEqual(entries[3].diff, { add: 3, del: 2 });
  assert.equal(entries[3].status, 'completed');
  assert.equal(entries[4].name, 'Bash');
  assert.equal(entries[4].input.command, 'pnpm test');
  assert.equal(entries[4].output, '3 passed');
  assert.equal(entries[5].text, 'Done.');
  assert.equal(entries[6].duration, 9000);
  assert.deepEqual(entries[6].files, [
    { name: 'login.ts', path: `${CWD}/src/login.ts`, add: 3, del: 2 }
  ]);
  assert.equal(r.busy, false);
  assert.equal(r.activity, 'idle');
  assert.equal(r.checkpoints.get('msg_1'), 'a'.repeat(40));
  assert.equal(r.title, 'Fix');
});

test('permission requests surface as pending cards and resolve into a note', () => {
  const { r, entries } = run([
    { kind: 'prompt', data: { messageId: 'msg_1', prompt: [{ type: 'text', text: 'clean up' }] } },
    { kind: 'turn.start' },
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      title: 'rm -rf dist',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rm -rf dist' }
    }),
    {
      kind: 'permission.request',
      data: {
        requestId: 'perm_4_1',
        toolCall: { toolCallId: 't9' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' }
        ]
      }
    }
  ]);
  assert.equal(r.activity, 'needs_input');
  const pending = r.permissions.get('perm_4_1')!;
  assert.equal(pending.request.permission, 'bash');
  assert.equal(pending.request.metadata.command, 'rm -rf dist');
  assert.deepEqual(pending.request.always, ['*']);
  assert.equal(pickOption(pending.options, 'once')!.optionId, 'yes');
  assert.equal(pickOption(pending.options, 'always')!.optionId, 'always');
  assert.equal(pickOption(pending.options, 'reject')!.optionId, 'no');
  r.apply({
    seq: 99,
    ts: 99,
    chatId: 'acp_x',
    kind: 'permission.resolve',
    data: { requestId: 'perm_4_1', optionId: 'yes' }
  });
  assert.equal(r.permissions.size, 0);
  assert.equal(r.activity, 'working');
  const note = entries.at(-1);
  assert.equal(note.kind, 'note');
  assert.equal(note.tone, 'allowed');
  assert.equal(note.target, 'rm -rf dist');
});

test('replayed events are ignored and a local prompt is adopted instead of duplicated', () => {
  const target = { entries: [] as any[] };
  const r = new AcpReducer('acp_x', target, CWD);
  target.entries.push({
    kind: 'user',
    key: 'local',
    text: 'hi',
    time: 1,
    messageID: 'msg_local',
    local: true
  });
  const ev = {
    seq: 1,
    ts: 5,
    chatId: 'acp_x',
    kind: 'prompt',
    data: { messageId: 'msg_local', prompt: [{ type: 'text', text: 'hi' }] }
  };
  assert.equal(r.apply(ev as AcpEvent), true);
  assert.equal(r.apply(ev as AcpEvent), false);
  assert.equal(target.entries.length, 1);
  assert.equal(target.entries[0].local, false);
  assert.equal(r.busy, true);
});

test('a crash, a cancel and a fatal start error read as errors and end the busy state', () => {
  const { r, entries } = run([
    { kind: 'error', data: { message: 'fx needs access to Vercel AI Gateway', fatal: 'true' } },
    { kind: 'prompt', data: { messageId: 'm', prompt: [{ type: 'text', text: 'go' }] } },
    { kind: 'turn.start' },
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'x',
      kind: 'execute',
      status: 'in_progress'
    }),
    { kind: 'turn.end', data: { stopReason: 'cancelled' } },
    { kind: 'agent.exit', data: { detail: 'signal: killed' } }
  ]);
  assert.match(r.fatal!, /Vercel/);
  assert.equal(r.busy, false);
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'error');
  assert.deepEqual(
    entries.filter((e) => e.kind === 'error').map((e) => e.detail),
    ['fx needs access to Vercel AI Gateway', 'Stopped', 'The agent stopped: signal: killed']
  );
});

test('plans render as a checklist that updates in place', () => {
  const { entries } = run([
    upd({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read code', status: 'in_progress' },
        { content: 'Fix', status: 'pending' }
      ]
    }),
    upd({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read code', status: 'completed' },
        { content: 'Fix', status: 'in_progress' }
      ]
    })
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '**Plan**\n- [x] Read code\n- [ ] Fix (in progress)');
});

test('config options from claude and opencode flatten into pickable values', () => {
  const { r } = run([
    {
      kind: 'session',
      data: {
        agentSessionId: 's1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { group: 'more', name: 'More', options: [{ value: 'opus', name: 'Opus' }] }
            ]
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: []
          }
        ]
      }
    },
    upd({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
  ]);
  assert.equal(r.agentSessionId, 's1');
  assert.deepEqual(
    acpOptionValues(r.configOptions[0]).map((o) => [o.value, o.group ?? null]),
    [
      ['default', null],
      ['opus', 'More']
    ]
  );
  assert.equal(r.configOptions[1].currentValue, 'plan');
});

test('tool kinds map onto the transcript tool names', () => {
  assert.equal(
    toolShape({ kind: 'read', locations: [{ path: `${CWD}/a/b.ts` }] }, CWD).summary,
    'b.ts'
  );
  assert.equal(toolShape({ kind: 'search', rawInput: { pattern: 'TODO' } }, CWD).name, 'Grep');
  assert.equal(toolShape({ kind: 'fetch', rawInput: { url: 'https://x' } }, CWD).name, 'WebFetch');
  assert.equal(
    toolShape(
      { kind: 'edit', content: [{ type: 'diff', path: '/p/new.ts', oldText: null, newText: 'x' }] },
      CWD
    ).name,
    'Write'
  );
  assert.equal(toolShape({ kind: 'other', title: 'mcp: deploy' }, CWD).name, 'mcp: deploy');
  assert.equal(toolStatus('in_progress'), 'running');
  assert.equal(toolStatus('failed'), 'error');
  assert.equal(toolStatus('weird'), null);
});

test('images and documents a tool returns are kept so the chat can preview them', () => {
  const png = Buffer.from('fake png').toString('base64');
  const pdf = Buffer.from('%PDF-1.4').toString('base64');
  const { r } = run([
    { kind: 'turn.start' },
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      title: 'Read shot.png',
      kind: 'read',
      status: 'in_progress',
      rawInput: { file_path: `${CWD}/shot.png` }
    }),
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'Image read successfully' } },
        { type: 'content', content: { type: 'image', data: png, mimeType: 'image/png' } },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///x/spec.pdf', mimeType: 'application/pdf', blob: pdf }
          }
        },
        { type: 'content', content: { type: 'image', data: 42 } }
      ]
    })
  ]);
  const tool = r.tools.get('t9');
  assert.deepEqual(tool?.files, [
    { src: `data:image/png;base64,${png}`, mime: 'image/png', name: null },
    {
      src: `data:application/pdf;base64,${pdf}`,
      mime: 'application/pdf',
      name: 'file:///x/spec.pdf'
    }
  ]);
  assert.equal(tool?.output, 'Image read successfully');
});
