import {
	ChatSessionStore,
	SessionThread,
	type ChatEntry,
	type ChatSession,
	type ChatComment
} from '$lib/components/sandbox/chat/session-store.svelte';

const BASE = Date.parse('2026-10-08T14:02:00Z');
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
