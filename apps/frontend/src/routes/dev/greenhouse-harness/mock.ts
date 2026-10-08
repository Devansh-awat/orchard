import type { LiveTransport } from '$lib/components/greenhouse';
import * as data from './data';

type Handler = (url: URL, init: RequestInit) => unknown;

function json(body: unknown, status = 200): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export function installFetch(role: 'owner' | 'collaborator' | 'viewer') {
	const result = { list: data.list() };
	const list = result.list;
	if (role !== 'owner') {
		for (const m of list.sandboxes)
			if (m.id === 'sbx-leaf') {
				m.myRole = role;
				m.owner = { id: data.ALEX.id, username: 'alex', email: 'alex@example.com' };
			}
	}
	let sessions = data.sessions();
	const routes: [RegExp, string, Handler][] = [
		[/^\/apiv1\/sandboxes$/, 'GET', () => list],
		[
			/^\/apiv1\/sandboxes\/[^/]+\/sessions$/,
			'GET',
			(u) => ({
				sessions: u.pathname.includes('sbx-leaf') ? sessions : []
			})
		],
		[
			/^\/apiv1\/sandboxes\/[^/]+\/sessions$/,
			'POST',
			(_u, init) => {
				const body = JSON.parse(String(init.body ?? '{}'));
				const s = {
					...sessions[0],
					id: crypto.randomUUID(),
					title: body.prompt?.slice(0, 40) ?? 'New session',
					activity: 'working' as const,
					updatedAt: new Date().toISOString()
				};
				sessions = [s, ...sessions];
				return s;
			}
		],
		[
			/^\/apiv1\/sandboxes\/[^/]+\/sessions\/[^/]+\/chats$/,
			'GET',
			(u) => {
				const s = sessions.find((x) => u.pathname.includes(x.id));
				return {
					chats: s?.opencodeSessionId
						? [{ id: s.opencodeSessionId, title: s.title, createdAt: s.createdAt }]
						: []
				};
			}
		],
		[/\/repos$/, 'GET', (u) => ({ repos: u.pathname.includes('sbx-leaf') ? data.repos : [] })],
		[/^\/apiv1\/sandboxes\/[^/]+\/members$/, 'GET', () => ({ ...data.members, myRole: role })],
		[/\/connect$/, 'GET', () => ({ sshHost: 'orchard-leaf-box', user: 'dev', sshReady: true })],
		[/\/changes$/, 'GET', () => data.changes],
		[/\/opencode\/file$/, 'GET', (u) => data.dir(u.searchParams.get('path') ?? '')],
		[
			/\/opencode\/find\/file$/,
			'GET',
			() => ['apps/server/src/auth/auth.controller.ts', 'apps/server/src/auth/oauth-state.ts']
		],
		[
			/\/file$/,
			'GET',
			(u) => ({ content: u.searchParams.get('ref') === 'HEAD' ? data.AUTH_HEAD : data.AUTH_NOW })
		],
		[/\/checks$/, 'GET', () => data.checks],
		[
			/\/ports$/,
			'GET',
			() => ({
				ports: [
					{ port: 5173, process: 'node (vite)', previewUrl: null, public: false },
					{ port: 3001, process: 'node (nest)', previewUrl: null, public: false }
				]
			})
		],
		[
			/\/scripts$/,
			'GET',
			() => ({
				setup: 'pnpm install',
				run: 'pnpm dev',
				ports: [5173],
				setupState: 'done',
				running: true
			})
		],
		[/\/comments$/, 'GET', () => ({ comments: [] })],
		[/\/authors$/, 'GET', () => ({ authors: { msg_u3: data.ALEX } })],
		[/\/boot$/, 'GET', () => ({ phase: 'ready', ready: true, label: 'Ready' })],
		[
			/\/organizations\/[^/]+\/members$/,
			'GET',
			() => [
				{ user: { id: 'user-jo', firstName: 'Jo', lastName: 'Park', email: 'jo@example.com' } },
				{ user: { id: 'user-mia', firstName: 'Mia', lastName: 'Chen', email: 'mia@example.com' } }
			]
		],
		[
			/\/ssh-identities$/,
			'GET',
			() => ({
				identities: [{ id: 'id1', name: 'laptop', publicKey: 'ssh-ed25519 AAAA', createdAt: '' }]
			})
		]
	];
	const real = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, location.origin);
		const at = url.pathname.indexOf('/apiv1/');
		if (at === -1) return real(input, init);
		const path = url.pathname.slice(at);
		const method = (init.method ?? 'GET').toUpperCase();
		for (const [re, m, handler] of routes) {
			if (m === method && re.test(path)) return json(handler(url, init));
		}
		if (method !== 'GET') return json({ ok: true, output: '' });
		return json({ message: 'Not found' }, 404);
	};
	return result.list;
}

export function fakeLive(role: 'owner' | 'collaborator' | 'viewer'): LiveTransport {
	return {
		connect(_url, handlers) {
			const host = role === 'owner' ? data.SEB : data.ALEX;
			const guest = role === 'owner' ? data.ALEX : data.SEB;
			setTimeout(() => {
				handlers.open();
				handlers.frame({
					t: 'roster',
					users: [
						{ ...host, color: '--hue-blue', role: 'owner', view: { tab: 'chat:ses_login' } },
						{
							...guest,
							color: '--hue-pink',
							role: 'collaborator',
							view: { tab: 'chat:ses_login' }
						},
						{ ...data.SAM, color: '--hue-emerald', role: 'viewer', view: { tab: 'diff' } }
					]
				});
				handlers.frame({
					t: 'draft',
					user: data.ALEX,
					chatId: 'ses_login',
					text: 'also check the staging cookie domain'
				});
			}, 30);
			return { send() {}, close() {} };
		}
	};
}
