import { parsePermission, parseQuestion } from '../../sandbox/chat/pending';
import {
  ChatSessionStore,
  SessionThread,
  type ChatEntry,
  type ChatSession,
  type ChatComment
} from '../../sandbox/chat/session-store.svelte';

const BASE = Date.now() - 8 * 60_000;
const SEB = { id: 'user-seb', name: 'Seb' };
const ALEX = { id: 'user-alex', name: 'Alex Rivera' };
const SAM = { id: 'user-sam', name: 'Sam Okafor' };

const MARKDOWN = `The redirect loop comes from the session cookie being scoped to \`app.orchard.my\` while the login callback lands on \`orchard.my\`. I scoped it to the parent domain and added a regression test.

Two things changed:

1. \`auth.controller.ts\` now sets \`domain\` from \`COOKIE_DOMAIN\` instead of the request host
2. the callback keeps \`returnTo\` through the OAuth state, so you land where you started

\`\`\`ts
res.cookie('session', token, { domain: env.COOKIE_DOMAIN, sameSite: 'lax' });
\`\`\`

<img src=x onerror="alert('xss')"> The tag before this sentence is sanitized away.`;

function sessions(): ChatSession[] {
  return [
    {
      id: 'ses_login',
      title: 'Fix the login redirect loop',
      directory: '/persist/home/.worktrees/orchard/fix-login',
      repo: 'fix-login',
      pending: false,
      createdAt: BASE,
      updatedAt: BASE
    },
    {
      id: 'ses_dark',
      title: 'Dark mode for the billing page',
      directory: '/persist/home/orchard',
      repo: 'orchard',
      pending: false,
      createdAt: BASE - 3_600_000,
      updatedAt: BASE - 3_600_000
    }
  ];
}

function entries(): ChatEntry[] {
  return [
    {
      kind: 'user',
      key: 'u1',
      text: 'Logging in on app.orchard.my bounces me back to the login page forever. Can you find out why and fix it?',
      time: BASE,
      messageID: 'msg_u1'
    },
    {
      kind: 'thinking',
      key: 'th1',
      time: BASE + 5000,
      text: 'The loop suggests the session cookie is set but never sent back. Likely a domain mismatch between the callback host and the app host. Check auth.controller.ts cookie options first.',
      done: true,
      expanded: false
    },
    {
      kind: 'tool',
      key: 't1',
      time: BASE + 8000,
      id: 'prt_1',
      name: 'Grep',
      input: { pattern: 'res.cookie\\(', path: 'apps/server/src' },
      output: 'apps/server/src/auth/auth.controller.ts:212',
      summary: 'res.cookie\\(',
      title: 'res.cookie\\(',
      diff: null,
      status: 'completed',
      failed: false,
      expanded: false
    },
    {
      kind: 'tool',
      key: 't2',
      time: BASE + 11000,
      id: 'prt_2',
      name: 'Read',
      input: { file_path: '/persist/home/orchard/apps/server/src/auth/auth.controller.ts' },
      output: null,
      summary: 'auth.controller.ts',
      title: '/persist/home/orchard/apps/server/src/auth/auth.controller.ts',
      diff: null,
      status: 'completed',
      failed: false,
      expanded: false
    },
    {
      kind: 'tool',
      key: 't3',
      time: BASE + 15000,
      id: 'prt_3',
      name: 'Edit',
      input: {
        file_path: '/persist/home/orchard/apps/server/src/auth/auth.controller.ts',
        old_string: "res.cookie('session', token, { sameSite: 'lax' });",
        new_string:
          "res.cookie('session', token, {\n  domain: env.COOKIE_DOMAIN,\n  sameSite: 'lax'\n});"
      },
      output: null,
      summary: 'auth.controller.ts',
      title: '/persist/home/orchard/apps/server/src/auth/auth.controller.ts',
      diff: { add: 4, del: 1 },
      status: 'completed',
      failed: false,
      expanded: true
    },
    {
      kind: 'tool',
      key: 't4',
      time: BASE + 22000,
      id: 'prt_4',
      name: 'Bash',
      input: { command: 'pnpm --filter server test auth' },
      output: 'PASS  test/auth.test.ts (14 tests)\nDone in 3.1s',
      summary: 'pnpm --filter server test auth',
      title: 'pnpm --filter server test auth',
      diff: null,
      status: 'completed',
      failed: false,
      expanded: false
    },
    {
      kind: 'agent',
      key: 'a1',
      time: BASE + 30000,
      id: 'prt_5',
      childID: 'ses_child',
      description: 'Check every other cookie for the same scoping bug',
      agentType: 'explore',
      status: 'completed',
      expanded: false,
      loaded: true,
      loading: false,
      entries: []
    },
    { kind: 'text', key: 'x1', time: BASE + 40000, text: MARKDOWN },
    {
      kind: 'result',
      key: 'r1',
      time: BASE + 48000,
      cost: 0.21,
      duration: 48_200,
      files: [
        {
          name: 'auth.controller.ts',
          path: 'apps/server/src/auth/auth.controller.ts',
          add: 4,
          del: 1
        },
        { name: 'auth.test.ts', path: 'apps/server/test/auth.test.ts', add: 31, del: 0 }
      ]
    },
    {
      kind: 'user',
      key: 'u2',
      text: 'Nice. Now make the callback keep returnTo.',
      time: BASE + 300_000,
      messageID: 'msg_u2',
      author: ALEX
    },
    {
      kind: 'thinking',
      key: 'th2',
      time: BASE + 305000,
      text: 'returnTo needs to survive the provider round trip. The OAuth state param is already signed, so it can carry the path.\nI should validate it is a relative path so this cannot become an open redirect.',
      done: false,
      expanded: false
    },
    {
      kind: 'tool',
      key: 't5',
      time: BASE + 310000,
      id: 'prt_6',
      name: 'Write',
      input: {
        file_path: '/persist/home/orchard/apps/server/src/auth/return-to.ts',
        content:
          'export function safeReturnTo(value: string) {\n  return value.startsWith("/") ? value : "/";\n}\n'
      },
      output: null,
      summary: 'return-to.ts',
      title: '/persist/home/orchard/apps/server/src/auth/return-to.ts',
      diff: { add: 3, del: 0 },
      status: 'error',
      failed: true,
      expanded: false
    },
    {
      kind: 'tool',
      key: 't6',
      time: BASE + 318000,
      id: 'prt_7',
      name: 'Bash',
      input: { command: 'pnpm --filter server lint' },
      output: null,
      summary: 'pnpm --filter server lint',
      title: 'pnpm --filter server lint',
      diff: null,
      status: 'running',
      failed: false,
      expanded: false
    },
    {
      kind: 'thinking',
      key: 'th3',
      time: BASE + 325000,
      text: 'Lint is running. While it runs, double check the state param is HMACed with the session secret and not just base64.',
      done: false,
      expanded: false
    }
  ];
}

function comments(): ChatComment[] {
  return [
    {
      id: 'c1',
      author: SAM,
      body: 'Heads up, the staging cookie domain is .staging.orchard.my, not the apex.',
      createdAt: BASE + 120_000,
      sessionId: 'ses_login'
    },
    {
      id: 'c2',
      author: ALEX,
      body: 'Good catch. I will ask it to handle returnTo while we are here.',
      createdAt: BASE + 250_000,
      sessionId: 'ses_login'
    },
    {
      id: 'c3',
      author: SEB,
      body: 'Sounds good, I will review once lint passes.',
      createdAt: BASE + 302_000,
      sessionId: 'ses_login'
    }
  ];
}

export function fixtureStore(): ChatSessionStore {
  const store = new ChatSessionStore('harness', { self: SEB });
  store.connection = 'ready';
  store.settled = true;
  store.models = [
    {
      providerID: 'anthropic',
      providerName: 'Anthropic',
      modelID: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      context: 200_000,
      variants: ['low', 'high']
    },
    {
      providerID: 'anthropic',
      providerName: 'Anthropic',
      modelID: 'claude-opus-4-1',
      name: 'Claude Opus 4.1',
      context: 200_000,
      variants: []
    }
  ];
  store.variant = 'high';
  store.sessions = sessions();
  const thread = new SessionThread('ses_login');
  thread.loaded = true;
  thread.entries = entries();
  thread.busy = true;
  thread.ctxTokens = {
    total: 128_400,
    input: 96_000,
    output: 8_400,
    reasoning: 4_000,
    cache: { read: 18_000, write: 2_000 }
  };
  thread.queue = [
    {
      id: 'q1',
      text: 'Then open a PR against main with a short description',
      attachments: [],
      choice: store.choice(),
      createdAt: BASE + 400_000
    },
    {
      id: 'q2',
      text: 'and ping me when CI is green',
      attachments: [],
      choice: store.choice(),
      createdAt: BASE + 410_000
    }
  ];
  store.threads.set(thread.id, thread);
  store.activity.set('ses_login', 'busy');
  store.activeId = thread.id;
  store.comments = comments();
  store.authorOf = (id) => (id === 'msg_u1' ? SEB : null);
  return store;
}

function tool(
  key: string,
  time: number,
  name: string,
  input: Record<string, unknown>,
  summary: string,
  extra: Partial<Extract<ChatEntry, { kind: 'tool' }>> = {}
): ChatEntry {
  return {
    kind: 'tool',
    key,
    time,
    id: `prt_${key}`,
    name,
    input,
    output: null,
    summary,
    title: summary,
    diff: null,
    status: 'completed',
    failed: false,
    expanded: false,
    ...extra
  };
}

function longEntries(): ChatEntry[] {
  const first = entries().slice(0, 9);
  const T2 = BASE + 300_000;
  const T3 = BASE + 900_000;
  const T4 = BASE + 1_500_000;
  return [
    ...first,
    {
      kind: 'user',
      key: 'u2',
      text: 'Nice. Now make the callback keep returnTo.',
      time: T2,
      messageID: 'msg_u2',
      author: ALEX
    },
    {
      kind: 'thinking',
      key: 'th2',
      time: T2 + 4000,
      text: 'returnTo needs to survive the provider round trip. The OAuth state param is already signed, so it can carry the path.',
      done: true,
      expanded: false
    },
    tool(
      't5',
      T2 + 9000,
      'Write',
      { file_path: 'apps/server/src/auth/return-to.ts', content: 'export {}' },
      'return-to.ts',
      { status: 'error', failed: true, diff: { add: 3, del: 0 } }
    ),
    tool(
      't6',
      T2 + 14000,
      'Write',
      {
        file_path: 'apps/server/src/auth/return-to.ts',
        content:
          'export function safeReturnTo(value: string) {\n  return value.startsWith("/") ? value : "/";\n}\n'
      },
      'return-to.ts',
      { diff: { add: 3, del: 0 } }
    ),
    tool(
      't7',
      T2 + 19000,
      'Edit',
      { file_path: 'apps/server/src/auth/oauth-state.ts' },
      'oauth-state.ts',
      { diff: { add: 9, del: 1 } }
    ),
    tool(
      't8',
      T2 + 26000,
      'Bash',
      { command: 'pnpm --filter server lint' },
      'pnpm --filter server lint',
      { output: 'Done in 4.2s' }
    ),
    {
      kind: 'text',
      key: 'x2',
      time: T2 + 31000,
      text: 'The callback now reads `returnTo` from the signed state and only accepts relative paths, so it cannot become an open redirect. Lint is clean.'
    },
    {
      kind: 'result',
      key: 'r2',
      time: T2 + 33000,
      cost: 0.08,
      duration: 33_400,
      files: [
        { name: 'return-to.ts', path: 'apps/server/src/auth/return-to.ts', add: 3, del: 0 },
        { name: 'oauth-state.ts', path: 'apps/server/src/auth/oauth-state.ts', add: 9, del: 1 },
        {
          name: 'auth.controller.ts',
          path: 'apps/server/src/auth/auth.controller.ts',
          add: 2,
          del: 1
        },
        {
          name: 'auth-redirect.test.ts',
          path: 'apps/server/test/auth-redirect.test.ts',
          add: 31,
          del: 0
        },
        {
          name: '+page.svelte',
          path: 'apps/frontend/src/routes/login/+page.svelte',
          add: 2,
          del: 0
        }
      ]
    },
    {
      kind: 'user',
      key: 'u3',
      text: 'What would break if COOKIE_DOMAIN is unset in a self hosted install?',
      time: T3,
      messageID: 'msg_u3'
    },
    {
      kind: 'text',
      key: 'x3',
      time: T3 + 6000,
      text: 'Nothing breaks. When `COOKIE_DOMAIN` is unset the cookie falls back to the request host, which is exactly the old behaviour. Single host installs never see the loop because the callback and the app share a host.'
    },
    { kind: 'result', key: 'r3', time: T3 + 6500, cost: 0.01, duration: 6_200, files: [] },
    {
      kind: 'user',
      key: 'u4',
      text: 'Deploy it to staging so I can try the flow.',
      time: T4,
      messageID: 'msg_u4',
      author: SAM
    },
    tool(
      't9',
      T4 + 5000,
      'Bash',
      { command: 'orchard deploy --env staging' },
      'orchard deploy --env staging',
      { status: 'error', failed: true, output: 'error: no staging environment linked' }
    ),
    {
      kind: 'error',
      key: 'e4',
      time: T4 + 6000,
      detail: 'This sandbox has no staging environment linked. Link one in the project settings.'
    },
    { kind: 'result', key: 'r4', time: T4 + 6500, cost: 0.02, duration: 6_500, files: [] }
  ];
}

function longComments(): ChatComment[] {
  return [
    ...comments().slice(0, 2),
    {
      id: 'c4',
      author: ALEX,
      body: 'Also worth checking the mobile app, it uses the same cookie.',
      createdAt: BASE + 260_000,
      sessionId: 'ses_login'
    },
    {
      id: 'c5',
      author: SEB,
      body: 'Looks right to me. One question for the agent first.',
      createdAt: BASE + 850_000,
      sessionId: 'ses_login'
    },
    {
      id: 'c6',
      author: SAM,
      body: 'I will try it on staging.',
      createdAt: BASE + 1_400_000,
      sessionId: 'ses_login'
    }
  ];
}

export function longStore(): ChatSessionStore {
  const store = fixtureStore();
  const thread = store.active;
  if (thread) {
    thread.entries = longEntries();
    thread.busy = false;
    thread.queue = [];
  }
  store.activity.set('ses_login', 'idle');
  store.comments = longComments();
  store.authorOf = (id) => (id === 'msg_u1' || id === 'msg_u3' ? SEB : null);
  return store;
}

const DIR = '/persist/home/.worktrees/orchard/fix-login';

export function seedRequests(store: ChatSessionStore, kind: 'ask' | 'plan') {
  const requests =
    kind === 'plan'
      ? [
          parseQuestion({
            id: 'que_plan',
            sessionID: 'ses_login',
            questions: [
              {
                question: `Plan at ${DIR}/.opencode/plans/1-login.md is complete. Would you like to switch to the build agent and start implementing?`,
                header: 'Build Agent',
                custom: false,
                options: [
                  {
                    label: 'Yes',
                    description: 'Switch to build agent and start implementing the plan'
                  },
                  { label: 'No', description: 'Stay with plan agent to continue refining the plan' }
                ]
              }
            ]
          })
        ]
      : [
          parsePermission({
            id: 'per_edit',
            sessionID: 'ses_login',
            permission: 'edit',
            patterns: ['src/auth/auth.controller.ts'],
            always: ['*'],
            metadata: {
              filepath: `${DIR}/src/auth/auth.controller.ts`,
              diff: `--- a\n+++ b\n@@ -40,3 +40,3 @@\n   const token = await this.sessions.mint(user);\n-  res.cookie('session', token, { domain: req.hostname });\n+  res.cookie('session', token, { domain: env.COOKIE_DOMAIN, sameSite: 'lax' });\n   return res.redirect(returnTo);\n`
            }
          }),
          parsePermission({
            id: 'per_bash',
            sessionID: 'ses_login',
            permission: 'bash',
            patterns: ['pnpm --filter server test'],
            always: ['pnpm *'],
            metadata: { command: 'pnpm --filter server test' }
          }),
          parseQuestion({
            id: 'que_db',
            sessionID: 'ses_login',
            questions: [
              {
                question: 'Where should the cookie domain come from?',
                header: 'Cookie domain',
                options: [
                  { label: 'COOKIE_DOMAIN', description: 'A new env var, set per deployment' },
                  { label: 'PUBLIC_URL', description: 'Derive it from the existing public URL' }
                ]
              },
              {
                question: 'Which environments need the fix?',
                header: 'Environments',
                multiple: true,
                options: [{ label: 'Production' }, { label: 'Staging' }, { label: 'Previews' }]
              }
            ]
          })
        ];
  for (const request of requests) if (request) store.addRequest(request, DIR);
}
