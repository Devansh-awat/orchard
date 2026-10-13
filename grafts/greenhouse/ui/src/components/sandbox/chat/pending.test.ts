import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answered,
  collectAnswers,
  describePermission,
  noteFor,
  parseDiff,
  parseOutcome,
  parsePermission,
  parseQuestion,
  parseRequestList,
  planHandoff,
  replyGone,
  waitingOn,
  requestDetail,
  type PermissionRequest,
  type QuestionRequest,
  type RequestAuthor
} from './pending';

const DIR = '/persist/home/.worktrees/orchard/fix-login';

const DIFF = `Index: ${DIR}/src/app.ts
===================================================================
--- ${DIR}/src/app.ts
+++ ${DIR}/src/app.ts
@@ -1,3 +1,3 @@
 import { a } from './a';
-const port = 3000;
+const port = Number(process.env.PORT ?? 3000);
 export default port;
`;

function permission(raw: Record<string, unknown>): PermissionRequest {
  const parsed = parsePermission(raw);
  assert.ok(parsed);
  return parsed;
}

function question(raw: Record<string, unknown>): QuestionRequest {
  const parsed = parseQuestion(raw);
  assert.ok(parsed);
  return parsed;
}

test('a current permission request keeps its patterns, always rules and tool reference', () => {
  const request = permission({
    id: 'per_1',
    sessionID: 'ses_1',
    permission: 'bash',
    patterns: ['npm test', 'npm run lint'],
    always: ['npm *'],
    metadata: { command: 'npm test && npm run lint' },
    tool: { messageID: 'msg_1', callID: 'call_1' }
  });
  assert.equal(request.legacy, false);
  assert.deepEqual(request.patterns, ['npm test', 'npm run lint']);
  assert.deepEqual(request.always, ['npm *']);
  assert.equal(request.messageID, 'msg_1');
  assert.equal(request.callID, 'call_1');
  const view = describePermission(request, DIR);
  assert.equal(view.icon, 'command');
  assert.equal(view.title, 'Run a command');
  assert.equal(view.detail, 'npm test && npm run lint');
  assert.equal(view.covers, 'Allow npm * without asking again');
});

test('a legacy permission.updated payload maps type, pattern and title onto the same shape', () => {
  const request = permission({
    id: 'per_old',
    type: 'bash',
    pattern: 'git push *',
    sessionID: 'ses_1',
    messageID: 'msg_2',
    callID: 'call_2',
    title: 'git push origin main',
    metadata: {},
    time: { created: 1 }
  });
  assert.equal(request.legacy, true);
  assert.equal(request.permission, 'bash');
  assert.deepEqual(request.patterns, ['git push *']);
  assert.deepEqual(request.always, ['git push *']);
  assert.equal(request.title, 'git push origin main');
  assert.equal(request.messageID, 'msg_2');
  assert.equal(describePermission(request).detail, 'git push *');
  const list = permission({ id: 'per_x', type: 'edit', pattern: ['a.ts', 'b.ts'], sessionID: 's' });
  assert.deepEqual(list.patterns, ['a.ts', 'b.ts']);
});

test('permission payloads missing an id, a session or a permission name are ignored', () => {
  assert.equal(parsePermission(null), null);
  assert.equal(parsePermission({ sessionID: 's', permission: 'bash' }), null);
  assert.equal(parsePermission({ id: 'p', permission: 'bash' }), null);
  assert.equal(parsePermission({ id: 'p', sessionID: 's' }), null);
  const bare = permission({ id: 'p', sessionID: 's', permission: 'bash' });
  assert.deepEqual(bare.patterns, []);
  assert.deepEqual(bare.metadata, {});
  assert.equal(bare.callID, null);
  assert.equal(describePermission(bare).detail, null);
  assert.equal(describePermission(bare).covers, null);
});

test('an edit shows the path relative to the worktree and a diff preview from the patch', () => {
  const request = permission({
    id: 'per_e',
    sessionID: 's',
    permission: 'edit',
    patterns: ['src/app.ts'],
    always: ['*'],
    metadata: { filepath: `${DIR}/src/app.ts`, diff: DIFF }
  });
  const view = describePermission(request, DIR);
  assert.equal(view.title, 'Edit src/app.ts');
  assert.equal(view.covers, 'Allow this kind of request without asking again');
  assert.deepEqual(view.diff, [
    { sign: ' ', text: "import { a } from './a';" },
    { sign: '−', text: 'const port = 3000;' },
    { sign: '+', text: 'const port = Number(process.env.PORT ?? 3000);' },
    { sign: ' ', text: 'export default port;' }
  ]);
  const absolute = permission({
    id: 'per_f',
    sessionID: 's',
    permission: 'edit',
    metadata: { filepath: `${DIR}/README.md` }
  });
  assert.equal(describePermission(absolute, DIR).title, 'Edit README.md');
  assert.equal(parseDiff('no hunks here'), null);
  assert.equal(parseDiff(undefined), null);
});

test('fetches, outside reads and unknown permissions get a plain title', () => {
  const fetch = permission({
    id: 'p1',
    sessionID: 's',
    permission: 'webfetch',
    patterns: ['https://example.com/docs'],
    metadata: { url: 'https://example.com/docs', format: 'markdown' }
  });
  assert.equal(describePermission(fetch).title, 'Fetch https://example.com/docs');
  const outside = permission({
    id: 'p2',
    sessionID: 's',
    permission: 'external_directory',
    patterns: ['/etc/*'],
    always: ['/etc/*'],
    metadata: { filepath: '/etc/hosts', parentDir: '/etc' }
  });
  const view = describePermission(outside, DIR);
  assert.equal(view.icon, 'folder');
  assert.equal(view.title, 'Work outside the worktree');
  assert.equal(view.detail, '/etc/*');
  assert.equal(view.covers, 'Allow /etc/* without asking again');
  const custom = permission({
    id: 'p3',
    sessionID: 's',
    permission: 'mcp_deploy',
    patterns: ['*']
  });
  assert.equal(describePermission(custom).title, 'Use mcp_deploy');
  assert.equal(requestDetail(custom), 'Use mcp_deploy');
});

test('questions keep options, default to allowing a custom answer and drop empty entries', () => {
  const request = question({
    id: 'que_1',
    sessionID: 'ses_1',
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'Redis' },
          { label: 'Postgres', description: 'duplicate' },
          { description: 'no label' }
        ]
      },
      { question: 'Which tables?', header: 'Tables', options: [], multiple: true },
      { header: 'no question' }
    ],
    tool: { messageID: 'msg_1', callID: 'call_1' }
  });
  assert.equal(request.questions.length, 2);
  assert.deepEqual(request.questions[0].options, [
    { label: 'Postgres', description: 'Relational' },
    { label: 'Redis', description: '' }
  ]);
  assert.equal(request.questions[0].custom, true);
  assert.equal(request.questions[0].multiple, false);
  assert.equal(request.questions[1].multiple, true);
  assert.equal(request.questions[1].custom, true);
  assert.equal(requestDetail(request), 'Which database?');
  assert.equal(parseQuestion({ id: 'q', sessionID: 's', questions: [] }), null);
  assert.equal(parseQuestion({ id: 'q', sessionID: 's' }), null);
  const closed = question({
    id: 'q',
    sessionID: 's',
    questions: [{ question: 'Pick', header: 'H', options: [{ label: 'A' }], custom: false }]
  });
  assert.equal(closed.questions[0].custom, false);
});

test('answers follow question order, one label for single choice and typed text wins', () => {
  const request = question({
    id: 'que_2',
    sessionID: 's',
    questions: [
      { question: 'One', header: 'A', options: [{ label: 'x' }, { label: 'y' }] },
      {
        question: 'Many',
        header: 'B',
        options: [{ label: 'p' }, { label: 'q' }],
        multiple: true
      },
      { question: 'Closed', header: 'C', options: [{ label: 'z' }], custom: false }
    ]
  });
  const answers = collectAnswers(
    request.questions,
    [['x', 'y'], ['p', 'q', 'ghost'], ['z']],
    ['', 'r', 'typed']
  );
  assert.deepEqual(answers, [['x'], ['p', 'q', 'r'], ['z']]);
  assert.deepEqual(collectAnswers(request.questions, [['x']], ['  mine  ']), [['mine'], [], []]);
  assert.deepEqual(answered(request.questions, [['x'], [], []], []), [true, false, false]);
});

test('the plan agent handoff is recognised from its question', () => {
  const handoff = question({
    id: 'que_plan',
    sessionID: 's',
    questions: [
      {
        question: `Plan at ${DIR}/.opencode/plans/1-login.md is complete. Would you like to switch to the build agent and start implementing?`,
        header: 'Build Agent',
        custom: false,
        options: [
          { label: 'Yes', description: 'Switch to build agent and start implementing the plan' },
          { label: 'No', description: 'Stay with plan agent to continue refining the plan' }
        ]
      }
    ]
  });
  assert.deepEqual(planHandoff(handoff), {
    path: `${DIR}/.opencode/plans/1-login.md`,
    yes: 'Yes',
    no: 'No'
  });
  const other = question({
    id: 'q',
    sessionID: 's',
    questions: [
      { question: 'Ship it?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  });
  assert.equal(planHandoff(other), null);
  assert.deepEqual(
    noteFor(
      handoff,
      parseOutcome('question.replied', {
        sessionID: 's',
        requestID: 'que_plan',
        answers: [['Yes']]
      })!
    ),
    {
      tone: 'allowed',
      lead: 'Started building',
      target: null,
      mono: false
    }
  );
  assert.equal(
    noteFor(handoff, { kind: 'question', id: 'que_plan', sessionID: 's', answers: [['No']] }).lead,
    'Kept planning'
  );
});

test('replied events parse in both the current and the legacy shape', () => {
  assert.deepEqual(
    parseOutcome('permission.replied', { sessionID: 's', requestID: 'per_1', reply: 'always' }),
    { kind: 'permission', id: 'per_1', sessionID: 's', reply: 'always' }
  );
  assert.deepEqual(
    parseOutcome('permission.replied', {
      sessionID: 's',
      permissionID: 'per_2',
      response: 'reject'
    }),
    { kind: 'permission', id: 'per_2', sessionID: 's', reply: 'reject' }
  );
  assert.equal(parseOutcome('permission.replied', { requestID: 'p', reply: 'maybe' }), null);
  assert.deepEqual(
    parseOutcome('question.replied', {
      sessionID: 's',
      requestID: 'q',
      answers: [['a'], ['b', 'c']]
    }),
    { kind: 'question', id: 'q', sessionID: 's', answers: [['a'], ['b', 'c']] }
  );
  assert.deepEqual(parseOutcome('question.rejected', { sessionID: 's', requestID: 'q' }), {
    kind: 'question',
    id: 'q',
    sessionID: 's',
    answers: null
  });
  assert.equal(parseOutcome('question.replied', { sessionID: 's' }), null);
  assert.equal(parseOutcome('session.idle', { sessionID: 's' }), null);
});

test('the quiet transcript line names what was allowed, denied or answered', () => {
  const bash = permission({
    id: 'per_1',
    sessionID: 's',
    permission: 'bash',
    patterns: ['npm test'],
    metadata: { command: 'npm test' }
  });
  assert.deepEqual(
    noteFor(bash, { kind: 'permission', id: 'per_1', sessionID: 's', reply: 'once' }),
    {
      tone: 'allowed',
      lead: 'Allowed',
      target: 'npm test',
      mono: true
    }
  );
  const edit = permission({
    id: 'per_2',
    sessionID: 's',
    permission: 'edit',
    patterns: ['src/x.ts']
  });
  assert.deepEqual(
    noteFor(edit, { kind: 'permission', id: 'per_2', sessionID: 's', reply: 'reject' }),
    {
      tone: 'denied',
      lead: 'Denied edit to',
      target: 'src/x.ts',
      mono: true
    }
  );
  assert.equal(
    noteFor(edit, { kind: 'permission', id: 'per_2', sessionID: 's', reply: 'always' }).lead,
    'Always allowed edit to'
  );
  const ask = question({
    id: 'q',
    sessionID: 's',
    questions: [{ question: 'Which?', header: 'H', options: [{ label: 'Postgres' }] }]
  });
  assert.deepEqual(
    noteFor(ask, { kind: 'question', id: 'q', sessionID: 's', answers: [['Postgres']] }),
    {
      tone: 'answered',
      lead: 'Answered',
      target: 'Postgres',
      mono: false
    }
  );
  assert.equal(
    noteFor(ask, { kind: 'question', id: 'q', sessionID: 's', answers: null }).lead,
    'Skipped the question'
  );
});

test('list endpoints are parsed defensively', () => {
  assert.deepEqual(parseRequestList('permission', { error: true }), []);
  const list = parseRequestList('question', [
    { id: 'q1', sessionID: 's', questions: [{ question: 'A?', header: 'A', options: [] }] },
    { id: 'q2' }
  ]);
  assert.deepEqual(
    list.map((r) => r.id),
    ['q1']
  );
});

test('a second reply to an answered request is told apart from a missing route', () => {
  assert.equal(
    replyGone({
      status: 404,
      body: {
        _tag: 'PermissionNotFoundError',
        requestID: 'per_1',
        message: 'Permission request not found: per_1'
      }
    }),
    true
  );
  assert.equal(replyGone({ status: 404, body: { _tag: 'QuestionNotFoundError' } }), true);
  assert.equal(replyGone({ status: 404, body: { _tag: 'ApiNotFoundError' } }), true);
  assert.equal(replyGone({ status: 409, body: null }), true);
  assert.equal(replyGone({ status: 404, body: '404 Not Found' }), false);
  assert.equal(replyGone({ status: 404, body: null }), false);
  assert.equal(replyGone({ status: 500, body: null }), null);
  assert.equal(replyGone({ status: 403, body: { message: 'Forbidden' } }), null);
});

test('a request waits on whoever sent the prompt that led to it', () => {
  const annabel = { id: 'u_annabel', name: 'Annabel', avatarUrl: null };
  const seb = { id: 'u_seb', name: 'seb' };
  const authors: Record<string, RequestAuthor> = { msg_a: annabel, msg_s: seb };
  const authorOf = (id: string) => authors[id] ?? null;

  assert.deepEqual(waitingOn({ messageID: 'msg_a' }, authorOf, 'u_seb'), annabel);
  assert.deepEqual(waitingOn({ messageID: 'msg_x', author: annabel }, authorOf, 'u_seb'), annabel);
  assert.equal(waitingOn({ messageID: 'msg_a' }, authorOf, 'u_annabel'), null);
  assert.equal(waitingOn({ messageID: 'msg_s' }, authorOf, 'u_seb'), null);
  assert.equal(waitingOn({ local: true, author: annabel }, authorOf, 'u_seb'), null);
  assert.equal(waitingOn({ messageID: 'msg_x' }, authorOf, 'u_seb'), null);
  assert.equal(waitingOn({ messageID: 'msg_a' }, authorOf, null), null);
  assert.equal(waitingOn(null, authorOf, 'u_seb'), null);
});
