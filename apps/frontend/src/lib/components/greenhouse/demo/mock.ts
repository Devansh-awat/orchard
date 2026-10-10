import type { LiveTransport } from '$lib/components/greenhouse';
import type { GhProjectLink, GhShareLink } from '$lib/components/greenhouse/types';
import * as data from './data';

type Handler = (url: URL, init: RequestInit) => unknown;

export type Route = [RegExp, string, Handler];

export function json(body: unknown, status = 200): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export type HarnessRole = 'owner' | 'collaborator' | 'viewer' | 'admin';

export function installFetch(role: HarnessRole) {
	const result = { list: data.list() };
	const list = result.list;
	const q = new URLSearchParams(location.search);
	if (q.get('apply') === 'error') {
		const m = list.sandboxes.find((x) => x.id === 'sbx-leaf');
		if (m) {
			m.applyError =
				'Kubernetes refused the pod: exceeded quota sandbox-cpu, requested 4, limited 2';
			m.applying = false;
		}
	}
	if (role !== 'owner') {
		for (const m of list.sandboxes)
			if (m.id === 'sbx-leaf') {
				m.myRole = role;
				m.owner = { id: data.ALEX.id, username: 'alex', email: 'alex@example.com' };
			}
	}
	let sessions = data.sessions();
	if (q.get('preview') === '1') {
		sessions = sessions.map((x, i) =>
			i === 0
				? {
						...x,
						previewDeploymentId: 'dep-preview-1',
						previewUrl: 'https://gh-fix-login.orchard-web.apps.orchard.my',
						previewStatus: 'ready' as const
					}
				: x
		);
	}
	let links: GhProjectLink[] = [...data.projectLinks];
	let shares: GhShareLink[] = [...data.shareLinks];
	const routes: Route[] = [
		...integrationRoutes(),
		[
			/\/sessions\/[^/]+\/preview-deploy$/,
			'POST',
			(u, init) => {
				const body = JSON.parse(String(init.body ?? '{}'));
				const sid = u.pathname.split('/sessions/')[1].split('/')[0];
				const s = sessions.find((x) => x.id === sid) ?? sessions[0];
				const next = {
					...s,
					previewDeploymentId: 'dep-preview-1',
					previewUrl: null,
					previewStatus: 'building' as const
				};
				sessions = sessions.map((x) => (x.id === next.id ? next : x));
				return {
					session: next,
					deploymentId: 'dep-preview-1',
					environmentId: 'env-gh',
					url: null,
					branch: s.branch,
					commit: '9f3c2ab7d1',
					redeployed: false,
					skippedEnv: body.projectId ? ['DATABASE_URL', 'REDIS_URL'] : []
				};
			}
		],
		[
			/\/sessions\/[^/]+\/preview-deploy$/,
			'DELETE',
			(u) => {
				const sid = u.pathname.split('/sessions/')[1].split('/')[0];
				const s = sessions.find((x) => x.id === sid) ?? sessions[0];
				const next = { ...s, previewDeploymentId: null, previewUrl: null, previewStatus: null };
				sessions = sessions.map((x) => (x.id === next.id ? next : x));
				return { session: next, removed: true };
			}
		],
		[/\/sandboxes\/[^/]+\/links$/, 'GET', () => ({ links })],
		[
			/\/sandboxes\/[^/]+\/links$/,
			'POST',
			(_u, init) => {
				const body = JSON.parse(String(init.body ?? '{}'));
				const project = data.projects.find((p) => p.id === body.projectId) ?? data.projects[0];
				const link = {
					id: crypto.randomUUID(),
					projectId: project.id,
					project: { id: project.id, name: project.name, slug: project.slug },
					environment: { id: 'env-prod', name: 'production', slug: 'production' },
					envFile: `~/.config/orchard/env/${project.slug}.env`,
					createdBy: data.SEB,
					createdAt: new Date().toISOString()
				};
				links = [...links, link];
				return link;
			}
		],
		[
			/\/sandboxes\/[^/]+\/links\/[^/]+$/,
			'DELETE',
			(u) => {
				const id = u.pathname.split('/').pop();
				links = links.filter((l) => l.projectId !== id);
				return { success: true };
			}
		],
		[/\/share-links$/, 'GET', () => ({ links: shares })],
		[
			/\/share-links$/,
			'POST',
			(_u, init) => {
				const body = JSON.parse(String(init.body ?? '{}'));
				const s = sessions.find((x) => x.id === body.sessionId);
				const link = {
					id: crypto.randomUUID(),
					sandboxId: 'sbx-leaf',
					sessionId: s?.id ?? null,
					session: s ? { id: s.id, title: s.title } : null,
					createdBy: data.SEB,
					state: 'active' as const,
					expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString(),
					revokedAt: null,
					lastUsedAt: null,
					createdAt: new Date().toISOString(),
					token: 'hX2_kq9-Zt4mW8rB1nVc7yLp0sDf3gJa5eUo6iQ_w-E',
					url: ''
				};
				shares = [link, ...shares];
				return link;
			}
		],
		[
			/\/share-links\/[^/]+$/,
			'DELETE',
			(u) => {
				const id = u.pathname.split('/').pop();
				shares = shares.map((l) =>
					l.id === id ? { ...l, state: 'revoked' as const, revokedAt: new Date().toISOString() } : l
				);
				return shares.find((l) => l.id === id);
			}
		],
		[
			/\/fork$/,
			'POST',
			() =>
				q.get('fork') === 'conflict'
					? json(
							{
								message:
									'The storage class longhorn-sandbox cannot take volume snapshots, so this machine cannot be forked'
							},
							409
						)
					: { id: 'sbx-fork', name: 'leaf-box-fork' }
		],
		[/\/apply\/retry$/, 'POST', () => ({ ok: true })],
		[
			/\/sandboxes\/[^/]+\/issues$/,
			'GET',
			(u) => {
				const term = (u.searchParams.get('q') ?? '').toLowerCase();
				return {
					repo: 'hackclub/orchard',
					issues: data.githubIssues.filter((i) => !term || i.title.toLowerCase().includes(term))
				};
			}
		],
		[/^\/apiv1\/projects$/, 'GET', () => data.projectRows],
		[/^\/apiv1\/projects\/[^/]+\/environments$/, 'GET', () => data.environments],
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
		[
			/\/repos\/[^/]+\/icon$/,
			'PUT',
			(u, init) => {
				const name = decodeURIComponent(u.pathname.split('/').at(-2) ?? '');
				const icon = (JSON.parse(String(init.body ?? '{}')) as { icon: string | null }).icon;
				const repo = data.repos.find((r) => r.name === name);
				if (!repo) return json({ message: 'No such repository' }, 404);
				if (q.get('icon') === 'fail') return json({ message: 'git config failed' }, 400);
				repo.icon = icon;
				return { name, icon };
			}
		],
		[
			/^\/apiv1\/sandboxes\/[^/]+\/members$/,
			'GET',
			() => ({
				...data.members,
				...(role === 'owner'
					? {}
					: { owner: { id: data.ALEX.id, name: data.ALEX.name, email: 'alex@example.com' } }),
				myRole: role
			})
		],
		[
			/\/git\/identity$/,
			'GET',
			() => {
				const linked = new URLSearchParams(location.search).get('github') !== 'none';
				return {
					name: data.SEB.name,
					email: 'seb@example.com',
					githubLogin: linked ? 'seb' : null,
					githubLinked: linked,
					canCommit: role !== 'viewer',
					canPush: linked && role !== 'viewer'
				};
			}
		],
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
			() => {
				const port = (n: number, process: string, exposable: boolean) => ({
					port: n,
					process,
					previewUrl: null,
					exposable,
					public: false,
					inSession: true,
					loopbackOnly: false,
					listening: true,
					declared: false
				});
				return {
					previewPorts: [3000, 3001, 4173, 5173, 8000, 8080, 8787],
					ports: [port(3001, 'node', true), port(5173, 'node', true), port(9229, 'node', false)]
				};
			}
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
			/\/me\/context$/,
			'GET',
			() => ({
				items: [
					{
						id: 'ctx-1',
						kind: 'instructions',
						name: 'CLAUDE.md',
						enabled: true,
						sizeBytes: 1200,
						secretKeys: []
					},
					{
						id: 'ctx-2',
						kind: 'agent',
						name: 'reviewer',
						enabled: true,
						sizeBytes: 900,
						secretKeys: []
					},
					{
						id: 'ctx-3',
						kind: 'command',
						name: 'git:ship',
						enabled: true,
						sizeBytes: 300,
						secretKeys: []
					},
					{
						id: 'ctx-4',
						kind: 'skill',
						name: 'frontend-design',
						enabled: false,
						sizeBytes: 18000,
						secretKeys: []
					},
					{
						id: 'ctx-5',
						kind: 'mcp',
						name: 'posthog',
						enabled: true,
						sizeBytes: 200,
						secretKeys: ['POSTHOG_API_KEY']
					}
				]
			})
		],
		[
			/\/me\/context\/ctx-1$/,
			'GET',
			() => ({
				files: {
					'CLAUDE.md':
						'# How I work\n\n- use pnpm, never npm\n- no comments in code\n- commit messages are one lowercase line\n'
				}
			})
		],
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
		],
		[/\/github\/status$/, 'GET', () => ({ linked: true })],
		[
			/\/github\/repositories$/,
			'GET',
			() => ({
				repositories: [
					{ id: 1, full_name: 'hackclub/orchard', private: true },
					{ id: 2, full_name: 'hackclub/orchard-docs', private: false },
					{ id: 3, full_name: 'leafd/dotfiles', private: false },
					{ id: 4, full_name: 'leafd/pip', private: true }
				]
			})
		]
	];
	const forbidden: string[] = [];
	Object.assign(window, { __ghForbidden: forbidden });
	const lifecycle = /^\/apiv1\/sandboxes\/sbx-leaf(\/(start|stop|apply\/retry))?$/;
	const real = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, location.origin);
		const at = url.pathname.indexOf('/apiv1/');
		if (at === -1) return real(input, init);
		const path = url.pathname.slice(at);
		const method = (init.method ?? 'GET').toUpperCase();
		if (role === 'admin' && path.startsWith('/apiv1/sandboxes/sbx-leaf') && !lifecycle.test(path)) {
			forbidden.push(`${method} ${path}`);
			return json({ message: 'Only the host and people they invite can open this machine' }, 403);
		}
		for (const [re, m, handler] of routes) {
			if (m === method && re.test(path)) {
				const out = handler(url, init);
				return out instanceof Response ? out : json(out);
			}
		}
		if (method !== 'GET') return json({ ok: true, output: '' });
		return json({ message: 'Not found' }, 404);
	};
	return result.list;
}

export function fakeLive(role: HarnessRole): LiveTransport {
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

export function integrationRoutes(): Route[] {
	const q = new URLSearchParams(location.search);
	const linearOn = q.get('linear') !== 'off';
	return [
		[
			/^\/apiv1\/integrations\/linear\/issues$/,
			'GET',
			(u) => {
				if (!linearOn) return { connected: false, issues: [] };
				const term = (u.searchParams.get('q') ?? '').toLowerCase();
				return {
					connected: true,
					issues: data.linearIssues.filter((i) => !term || i.title.toLowerCase().includes(term))
				};
			}
		],
		[
			/^\/apiv1\/users\/me\/integrations$/,
			'GET',
			() => ({
				integrations: [
					{ provider: 'github', account: 'seb', linkedAt: '2026-09-01T10:00:00Z' },
					...(linearOn
						? [{ provider: 'linear', account: 'Hack Club', linkedAt: '2026-10-01T10:00:00Z' }]
						: []),
					...(q.get('slack') === 'on'
						? [{ provider: 'slack', account: 'T0123ABCD', linkedAt: '2026-10-02T10:00:00Z' }]
						: [])
				]
			})
		],
		[
			/^\/apiv1\/users\/me\/integrations\/linear$/,
			'GET',
			() => ({ connected: linearOn, workspaceName: linearOn ? 'Hack Club' : null })
		],
		[
			/^\/apiv1\/users\/me\/integrations\/linear$/,
			'PUT',
			() => ({ connected: true, workspaceName: 'Hack Club' })
		],
		[
			/^\/apiv1\/integrations\/slack\/link\/preview$/,
			'POST',
			() =>
				q.get('slack') === 'expired'
					? json(
							{
								message:
									'This link has expired or was already used. Run /greenhouse link in Slack for a new one.'
							},
							400
						)
					: {
							teamId: 'T0123ABCD',
							slackUserId: 'U04SEB',
							slackUserName: 'seb',
							teamDomain: 'hackclub',
							expiresAt: new Date(Date.now() + 9 * 60_000).toISOString()
						}
		],
		[
			/^\/apiv1\/integrations\/slack\/link$/,
			'POST',
			() =>
				q.get('slack') === 'expired'
					? json(
							{
								message:
									'This link has expired or was already used. Run /greenhouse link in Slack for a new one.'
							},
							400
						)
					: { connected: true, teamId: 'T0123ABCD' }
		]
	];
}

export function installRoutes(routes: Route[]) {
	const real = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, location.origin);
		const at = url.pathname.indexOf('/apiv1/');
		if (at === -1) return real(input, init);
		const path = url.pathname.slice(at);
		const method = (init.method ?? 'GET').toUpperCase();
		for (const [re, m, handler] of routes) {
			if (m === method && re.test(path)) {
				const out = handler(url, init);
				return out instanceof Response ? out : json(out);
			}
		}
		return json({ message: `Cannot ${method} ${path}` }, 404);
	};
}
