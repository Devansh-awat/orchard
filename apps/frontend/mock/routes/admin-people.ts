import { uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const NAMES = [
	['Noor', 'Haddad'],
	['Theo', 'Lindqvist'],
	['Priya', 'Raman'],
	['Mateo', 'Silva'],
	['Ines', 'Moreau'],
	['Jonah', 'Weiss'],
	['Sana', 'Qureshi'],
	['Eli', 'Brandt'],
	['Maya', 'Okafor'],
	['Felix', 'Hart'],
	['Aiko', 'Tanaka'],
	['Luca', 'Romano'],
	['Zoe', 'Fischer'],
	['Omar', 'Nasser'],
	['Tess', 'Whitlock'],
	['Hugo', 'Duval'],
	['Lena', 'Kovacs'],
	['Ravi', 'Menon'],
	['Clara', 'Ostrom'],
	['Ivan', 'Petrov'],
	['Nia', 'Mensah'],
	['Owen', 'Byrne'],
	['Yuna', 'Seo'],
	['Sam', 'Ellery'],
	['Ada', 'Nwosu'],
	['Milo', 'Grant'],
	['Rosa', 'Vega'],
	['Finn', 'Holm'],
	['Dara', 'Quinn'],
	['Kofi', 'Boateng'],
	['Elsa', 'Berg'],
	['Tomas', 'Novak'],
	['Mina', 'Farah'],
	['Jude', 'Arden'],
	['Lior', 'Stern'],
	['Anya', 'Volkova'],
	['', ''],
	['Sol', '']
];

interface AdminUser {
	id: string;
	email: string;
	username: string;
	firstName: string | null;
	lastName: string | null;
	imageUrl: string | null;
	isSuperAdmin: boolean;
	createdAt: string;
	_count: { organizationMembers: number; projectMembers: number };
}

interface TunnelRoute {
	role: string;
	record: string;
	probe: string;
	label: string;
	routed: boolean;
	service: string | null;
}

function preset(cpuMilli: number, memoryBytes: number) {
	const sizes = [
		{ id: 'nano', cpuMilli: 50, memoryBytes: 64 * MIB },
		{ id: 'micro', cpuMilli: 100, memoryBytes: 128 * MIB },
		{ id: 'small', cpuMilli: 250, memoryBytes: 512 * MIB },
		{ id: 'medium', cpuMilli: 500, memoryBytes: GIB },
		{ id: 'large', cpuMilli: 1000, memoryBytes: 2 * GIB },
		{ id: 'xlarge', cpuMilli: 2000, memoryBytes: 4 * GIB }
	];
	const fit =
		sizes.find((s) => s.cpuMilli >= cpuMilli * 1.5 && s.memoryBytes >= memoryBytes * 1.5) ??
		sizes[sizes.length - 1];
	return { cpuMilli: fit.cpuMilli, memoryBytes: fit.memoryBytes, presetId: fit.id };
}

export function adminPeopleRoutes(r: Router, { store }: MockContext) {
	const projectCounts = new Map<string, number>();
	for (const project of store.state.projects) {
		for (const member of store.state.members) {
			if (member.organizationId !== project.organizationId) continue;
			projectCounts.set(member.userId, (projectCounts.get(member.userId) ?? 0) + 1);
		}
	}

	const seeded: AdminUser[] = store.state.users.map((u) => ({
		id: u.id,
		email: u.email,
		username: u.username,
		firstName: u.firstName,
		lastName: u.lastName,
		imageUrl: u.imageUrl,
		isSuperAdmin: u.isSuperAdmin,
		createdAt: u.createdAt,
		_count: {
			organizationMembers: store.state.members.filter((m) => m.userId === u.id).length,
			projectMembers: projectCounts.get(u.id) ?? 0
		}
	}));

	const generated: AdminUser[] = NAMES.map(([firstName, lastName], i) => {
		const handle = firstName ? `${firstName}.${lastName || 'orchard'}`.toLowerCase() : `user${i}`;
		return {
			id: uid(`admin-user:${i}`),
			email: `${handle}@example.test`,
			username: handle.replace('.', '_'),
			firstName: firstName || null,
			lastName: lastName || null,
			imageUrl: null,
			isSuperAdmin: i % 17 === 3,
			createdAt: ago((i + 2) * 3 * DAY),
			_count: { organizationMembers: i % 3, projectMembers: (i * 7) % 5 }
		};
	});

	let users = [...seeded, ...generated];

	r.get('/admin/users', ({ query }) => {
		const page = Number.parseInt(query.get('page') || '1', 10);
		const limit = Number.parseInt(query.get('limit') || '20', 10);
		const search = query.get('search')?.toLowerCase();
		const matches = (
			search
				? users.filter((u) =>
						[u.email, u.username, u.firstName, u.lastName].some((value) =>
							value?.toLowerCase().includes(search)
						)
					)
				: users
		).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
		return {
			users: matches.slice((page - 1) * limit, page * limit),
			total: matches.length,
			page,
			limit,
			totalPages: Math.ceil(matches.length / limit)
		};
	});

	r.patch('/admin/users/:id', ({ params, body }) => {
		const target = users.find((u) => u.id === params.id);
		if (!target) return notFound('User not found');
		if (body?.isSuperAdmin === false && params.id === store.state.meId) {
			return reply(403, {
				statusCode: 403,
				message: "You can't remove your own superadmin status"
			});
		}
		if (body?.firstName !== undefined) target.firstName = body.firstName;
		if (body?.lastName !== undefined) target.lastName = body.lastName;
		if (body?.isSuperAdmin !== undefined) target.isSuperAdmin = body.isSuperAdmin;
		return target;
	});

	r.delete('/admin/users/:id', ({ params }) => {
		if (params.id === store.state.meId) {
			return reply(403, { statusCode: 403, message: "You can't delete your own account" });
		}
		if (!users.some((u) => u.id === params.id)) return notFound('User not found');
		users = users.filter((u) => u.id !== params.id);
		return { success: true };
	});

	const orgRef = (id: string) => {
		const org = store.state.orgs.find((o) => o.id === id);
		return org ? { id: org.id, name: org.name, slug: org.slug } : null;
	};
	const projectRef = (id: string) => {
		const project = store.state.projects.find((p) => p.id === id);
		return project ? { id: project.id, name: project.name, slug: project.slug } : null;
	};

	const OBSERVED = [
		{ cpuMilli: 12, memoryBytes: 48 * MIB, pods: 1 },
		{ cpuMilli: 140, memoryBytes: 210 * MIB, pods: 2 },
		null,
		{ cpuMilli: 380, memoryBytes: 600 * MIB, pods: 3 },
		null,
		{ cpuMilli: 62, memoryBytes: 92 * MIB, pods: 1 }
	];

	let candidates = [
		...store.state.deployments.slice(0, 4).map((d) => ({ kind: 'deployment' as const, row: d })),
		...store.state.databases.slice(0, 2).map((d) => ({ kind: 'database' as const, row: d }))
	].map(({ kind, row }, i) => {
		const project = store.state.projects.find((p) => p.id === row.projectId);
		const sample = OBSERVED[i % OBSERVED.length];
		return {
			kind,
			id: row.id,
			name: row.name,
			namespace: `${project?.slug ?? 'default'}-production`,
			project: projectRef(row.projectId),
			organization: project ? orgRef(project.organizationId) : null,
			pods: sample?.pods ?? 0,
			observed: sample ? { cpuMilli: sample.cpuMilli, memoryBytes: sample.memoryBytes } : null,
			recommendation: sample ? preset(sample.cpuMilli, sample.memoryBytes) : null
		};
	});

	r.get('/admin/backfill/candidates', () => candidates);

	r.post('/admin/backfill/apply', ({ body }) => {
		if (!candidates.some((c) => c.kind === body?.kind && c.id === body?.id)) {
			return notFound('Not found');
		}
		candidates = candidates.filter((c) => !(c.kind === body.kind && c.id === body.id));
		return { success: true };
	});

	r.get('/admin/usage', () => {
		const orgs = [
			...store.state.orgs.map((o) => ({
				id: o.id,
				name: o.name,
				slug: o.slug,
				avatarUrl: o.avatarUrl ?? null
			})),
			{ id: uid('admin-org:sprig'), name: 'Sprig Labs', slug: 'sprig', avatarUrl: null },
			{ id: uid('admin-org:quiet'), name: 'Quiet Harbor', slug: 'quiet', avatarUrl: null }
		];
		const nodes = ['house', 'talos-worker-1', 'talos-worker-2'];
		return orgs.map((organization, i) => {
			const spread = nodes.slice(0, Math.max(1, nodes.length - i));
			const byNode = spread.map((nodeName, n) => {
				const pods = 8 - i - n * 2;
				return {
					nodeName,
					cpuMilli: pods * 250,
					memBytes: pods * 512 * MIB,
					pods
				};
			});
			return {
				organization,
				cpuMilli: byNode.reduce((sum, n) => sum + n.cpuMilli, 0),
				memoryBytes: byNode.reduce((sum, n) => sum + n.memBytes, 0),
				pods: byNode.reduce((sum, n) => sum + n.pods, 0),
				byNode
			};
		});
	});

	r.get('/audit-logs/global', ({ query }) => {
		const limit = Number.parseInt(query.get('limit') || '50', 10);
		const offset = Number.parseInt(query.get('cursor') || '0', 10);
		const action = query.get('action')?.trim();
		const actorRef = (id: string | null | undefined) => {
			const actor = store.user(id);
			return actor
				? {
						id: actor.id,
						email: actor.email,
						username: actor.username,
						firstName: actor.firstName,
						lastName: actor.lastName,
						imageUrl: actor.imageUrl
					}
				: null;
		};
		const rows = [
			...store.state.builds.map((b) => {
				const deployment = store.deployment(b.deploymentId);
				const actor = store.user(b.triggeredById);
				return {
					id: uid(`global-audit:${b.id}`),
					createdAt: b.createdAt,
					action: b.triggerType === 'push' ? 'deployment.build' : 'deployment.redeploy',
					actorUserId: actor?.id ?? null,
					actorEmail: actor?.email ?? null,
					organizationId: null,
					projectId: deployment?.projectId ?? null,
					deploymentId: b.deploymentId,
					targetType: 'deployment',
					targetId: b.deploymentId,
					targetLabel: deployment?.name ?? null,
					metadata: { branch: 'main' },
					actor: actorRef(b.triggeredById)
				};
			}),
			{
				id: uid('global-audit:superadmin'),
				createdAt: ago(2 * DAY),
				action: 'user.superadmin.granted',
				actorUserId: store.state.meId,
				actorEmail: store.me()?.email ?? null,
				organizationId: null,
				projectId: null,
				deploymentId: null,
				targetType: 'user',
				targetId: generated[3].id,
				targetLabel: generated[3].email,
				metadata: null,
				actor: actorRef(store.state.meId)
			},
			{
				id: uid('global-audit:pruned'),
				createdAt: ago(5 * DAY),
				action: 'audit.pruned',
				actorUserId: null,
				actorEmail: null,
				organizationId: null,
				projectId: null,
				deploymentId: null,
				targetType: null,
				targetId: null,
				targetLabel: null,
				metadata: { deleted: 1284 },
				actor: null
			}
		]
			.filter((row) => !action || row.action === action)
			.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
		const next = offset + limit;
		return {
			entries: rows.slice(offset, next),
			nextCursor: next < rows.length ? String(next) : null
		};
	});

	const tunnelValues: Record<string, string> = {
		apiToken: '',
		accountId: 'b2f1c6a94d7e4c0f8a31e5d07c9b6a12',
		tunnelId: '7c0d3e1a-5b42-4f96-8e2d-1a9f6b3c7d20',
		zoneId: ''
	};
	const routes: TunnelRoute[] = [
		{
			role: 'platform',
			record: 'orchard.example.com',
			probe: 'orchard.example.com',
			label: 'Dashboard',
			routed: true,
			service: 'http://traefik.orchard.svc:80'
		},
		{
			role: 'apps',
			record: '*.apps.example.com',
			probe: 'orchard-check.apps.example.com',
			label: 'Apps',
			routed: false,
			service: null
		},
		{
			role: 'mcp',
			record: 'mcp.example.com',
			probe: 'mcp.example.com',
			label: 'MCP',
			routed: false,
			service: null
		}
	];

	const tunnelState = () => ({
		configured: true,
		error: null,
		tunnelName: 'orchard-home',
		canEditDns: Boolean(tunnelValues.zoneId),
		routes,
		otherHostnames: ['grafana.example.com', 'ssh.example.com']
	});
	const tunnelSection = () => ({
		id: 'tunnel',
		configured: true,
		values: tunnelValues,
		lockedFields: [],
		secretFields: ['apiToken'],
		boolFields: []
	});

	r.get('/admin/networking/tunnel', () => tunnelState());
	r.post('/admin/networking/tunnel/routes', ({ body }) => {
		const route = routes.find((candidate) => candidate.record === body?.hostname);
		if (!route) return notFound('Hostname not found');
		route.routed = true;
		route.service = 'http://traefik.orchard.svc:80';
		return tunnelState();
	});
	r.get('/admin/instance-config/tunnel', () => tunnelSection());
	r.put('/admin/instance-config/tunnel', ({ body }) => {
		for (const name of Object.keys(tunnelValues)) {
			if (name !== 'apiToken' && typeof body?.[name] === 'string') tunnelValues[name] = body[name];
		}
		return tunnelSection();
	});
}
