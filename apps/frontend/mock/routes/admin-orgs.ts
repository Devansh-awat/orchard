import { freshId, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

type Scenario = 'ok' | 'empty' | 'error';

interface AdminOrg {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	avatarUrl: string | null;
	plan: string | null;
	createdAt: string;
	creator: {
		id: string;
		email: string;
		username: string;
		firstName: string | null;
		lastName: string | null;
	} | null;
	_count: { members: number; projects: number };
}

interface Quota {
	cpuLimitMilli: number | null;
	memoryLimitBytes: number | null;
	maxPods: number | null;
	maxServices: number | null;
	defaultPodCpuMilli: number | null;
	defaultPodMemoryBytes: number | null;
	quotaGroupId: string | null;
}

interface Usage {
	cpuMilli: number;
	memoryBytes: number;
	pods: number;
	services: number;
}

interface Taint {
	key: string;
	value: string | null;
	effect: string;
}

interface Assignment {
	id: string;
	nodeId: string;
	organizationId: string;
	mode: 'allow' | 'deny';
	cpuLimit: string | null;
	memoryLimit: string | null;
	maxServices: number | null;
	createdAt: string;
}

interface AdminNode {
	id: string;
	name: string;
	schedulable: boolean;
	notes: string | null;
	cpuCapacity: string | null;
	memoryCapacity: string | null;
	labels: Record<string, string>;
	taints: Taint[];
	lastSeenAt: string;
	usage: { cpuMilli: number; memoryBytes: number; pods: number };
}

interface NodePool {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	nodeSelector: unknown[];
	tolerations: unknown[];
	affinityMode: 'required' | 'preferred';
	userSelectable: boolean;
	_count: { deployments: number; jobs: number; databases: number };
}

const EXTRA_ORGS: [string, string, string | null, string | null, number, number][] = [
	['Northwind Labs', 'northwind', 'Internal tools and data pipelines', 'pro', 14, 9],
	['Meadow Health', 'meadow-health', 'Patient portal and scheduling', 'enterprise', 38, 21],
	['Fennel', 'fennel', null, 'free', 2, 1],
	['Blue Heron Press', 'blue-heron', 'Publishing and storefront', 'pro', 6, 4],
	['Arcadia Robotics', 'arcadia-robotics', 'Fleet telemetry', 'enterprise', 52, 33],
	['Tidewater Co-op', 'tidewater', null, 'free', 3, 2],
	['Lantern', 'lantern', 'Docs and support portal', 'pro', 8, 5],
	['Quillon Studio', 'quillon', 'Client sites', 'free', 4, 12],
	['Osprey Freight', 'osprey-freight', 'Dispatch and tracking', 'enterprise', 27, 18],
	['Juniper Bank Sandbox', 'juniper-sandbox', 'Throwaway test environment', null, 1, 0],
	['Hollow Pine', 'hollow-pine', null, 'free', 2, 3],
	['Kestrel Analytics', 'kestrel', 'Warehouse and dashboards', 'pro', 11, 7],
	['Saffron Kitchen', 'saffron', 'Ordering app', 'free', 3, 2],
	['Marrow & Co', 'marrow-co', null, null, 1, 1],
	['Everline Transit', 'everline', 'Timetables and live vehicle positions', 'enterprise', 41, 26],
	['Thistle', 'thistle', null, 'free', 2, 1],
	['Copperfield Games', 'copperfield', 'Leaderboards and matchmaking', 'pro', 16, 14],
	['Wren Education', 'wren-education', 'Course platform', 'pro', 9, 6],
	['Ironwood Civic', 'ironwood-civic', null, 'free', 5, 2],
	['Sable Audio', 'sable-audio', 'Streaming backend', 'pro', 7, 8],
	['Pinecrest Clinic With A Very Long Organization Name Inc', 'pinecrest', null, 'free', 2, 1],
	['Gallery Row', 'gallery-row', 'Artist storefronts', 'free', 3, 2]
];

const STANDARD_LABELS = (name: string, zone: string) => ({
	'kubernetes.io/arch': 'amd64',
	'kubernetes.io/hostname': name,
	'kubernetes.io/os': 'linux',
	'topology.kubernetes.io/zone': zone
});

export function adminOrgRoutes(r: Router, { store }: MockContext) {
	const scenario: Record<'organizations' | 'nodes' | 'pools', Scenario> = {
		organizations: 'ok',
		nodes: 'ok',
		pools: 'ok'
	};

	const failure = () => reply(500, { statusCode: 500, message: 'Internal server error' });
	const toUser = (u: (typeof store.state.users)[number]) => ({
		id: u.id,
		email: u.email,
		username: u.username,
		firstName: u.firstName ?? null,
		lastName: u.lastName ?? null
	});

	const [creator, ...rest] = store.state.users;
	const orgs: AdminOrg[] = [
		...store.state.orgs.map((o) => ({
			id: o.id,
			name: o.name,
			slug: o.slug,
			description: o.description,
			avatarUrl: o.avatarUrl,
			plan: o.plan,
			createdAt: o.createdAt,
			creator: toUser(creator),
			_count: {
				members: store.state.members.filter((m) => m.organizationId === o.id).length,
				projects: store.state.projects.filter((p) => p.organizationId === o.id).length
			}
		})),
		...EXTRA_ORGS.map(([name, slug, description, plan, members, projects], i) => ({
			id: uid(`admin-org:${slug}`),
			name,
			slug,
			description,
			avatarUrl: null,
			plan,
			createdAt: new Date(Date.now() - (i + 2) * 11 * 86_400_000).toISOString(),
			creator: i % 5 === 3 ? null : toUser(rest[i % rest.length] ?? creator),
			_count: { members, projects }
		}))
	];

	const quotas = new Map<string, Quota>();
	const usage = new Map<string, Usage>();
	orgs.forEach((o, i) => {
		const capped = i % 3 !== 1;
		quotas.set(o.id, {
			cpuLimitMilli: capped ? 16_000 : null,
			memoryLimitBytes: capped ? 32 * GIB : null,
			maxPods: capped ? 120 : null,
			maxServices: capped ? 40 : null,
			defaultPodCpuMilli: capped ? 100 : null,
			defaultPodMemoryBytes: capped ? 128 * MIB : null,
			quotaGroupId: null
		});
		usage.set(o.id, {
			cpuMilli: 500 + ((i * 1700) % 15_000),
			memoryBytes: (1 + ((i * 3) % 30)) * GIB,
			pods: 3 + ((i * 7) % 100),
			services: 1 + ((i * 3) % 30)
		});
	});

	const emptyQuota = (): Quota => ({
		cpuLimitMilli: null,
		memoryLimitBytes: null,
		maxPods: null,
		maxServices: null,
		defaultPodCpuMilli: null,
		defaultPodMemoryBytes: null,
		quotaGroupId: null
	});
	const quotaOf = (id: string) => {
		const found = quotas.get(id);
		if (found) return found;
		const fresh = emptyQuota();
		quotas.set(id, fresh);
		return fresh;
	};
	const groupOf = (id: string) => {
		const group = quotaOf(id).quotaGroupId;
		return group ? orgs.filter((o) => quotaOf(o.id).quotaGroupId === group) : [];
	};
	const quotaView = (id: string) => {
		const org = orgs.find((o) => o.id === id)!;
		const q = quotaOf(id);
		const members = q.quotaGroupId ? groupOf(id) : [org];
		const pool = members.reduce<Usage>(
			(sum, o) => {
				const u = usage.get(o.id);
				return {
					cpuMilli: sum.cpuMilli + (u?.cpuMilli ?? 0),
					memoryBytes: sum.memoryBytes + (u?.memoryBytes ?? 0),
					pods: sum.pods + (u?.pods ?? 0),
					services: sum.services + (u?.services ?? 0)
				};
			},
			{ cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 }
		);
		return {
			org: { id: org.id, name: org.name, ...q },
			usage: pool,
			connections: members
				.filter((o) => o.id !== id)
				.map((o) => ({ id: o.id, name: o.name, slug: o.slug }))
				.sort((a, b) => a.name.localeCompare(b.name))
		};
	};

	const youngest = orgs[2];
	const oldest = orgs[6];
	if (youngest && oldest) {
		const group = uid('admin-quota-group');
		quotaOf(youngest.id).quotaGroupId = group;
		quotaOf(oldest.id).quotaGroupId = group;
	}

	r.post('/__mock/admin/scenario', ({ body }) => {
		for (const key of ['organizations', 'nodes', 'pools'] as const) {
			if (body?.[key]) scenario[key] = body[key];
		}
		return scenario;
	});

	r.get('/admin/organizations', ({ query }) => {
		if (scenario.organizations === 'error') return failure();
		const page = Math.max(1, parseInt(query.get('page') || '1', 10));
		const limit = Math.max(1, parseInt(query.get('limit') || '20', 10));
		const search = query.get('search')?.toLowerCase();
		const pool = scenario.organizations === 'empty' ? [] : orgs;
		const matching = search
			? pool.filter(
					(o) => o.name.toLowerCase().includes(search) || o.slug.toLowerCase().includes(search)
				)
			: pool;
		return {
			organizations: matching.slice((page - 1) * limit, page * limit),
			total: matching.length,
			page,
			limit,
			totalPages: Math.ceil(matching.length / limit)
		};
	});

	r.post('/admin/organizations', ({ body }) => {
		if (!body?.name || !body?.slug) {
			return reply(400, { statusCode: 400, message: 'Name and slug are required' });
		}
		if (orgs.some((o) => o.slug === body.slug)) {
			return reply(409, { statusCode: 409, message: 'That slug is already taken' });
		}
		const email = body.primaryOwnerEmail?.trim().toLowerCase();
		const owner = email ? store.state.users.find((u) => u.email.toLowerCase() === email) : null;
		const created: AdminOrg = {
			id: freshId(),
			name: body.name,
			slug: body.slug,
			description: body.description ?? null,
			avatarUrl: body.avatarUrl ?? null,
			plan: body.plan ?? null,
			createdAt: new Date().toISOString(),
			creator: owner ? toUser(owner) : null,
			_count: { members: owner ? 1 : 0, projects: 0 }
		};
		orgs.unshift(created);
		const { creator: _creator, _count, ...organization } = created;
		return email && !owner
			? { organization, inviteLink: `http://localhost:3000/invite/${freshId()}` }
			: { organization };
	});

	r.patch('/admin/organizations/:id', ({ params, body }) => {
		const org = orgs.find((o) => o.id === params.id);
		if (!org) return notFound('Organization not found');
		if (body?.name !== undefined) org.name = body.name;
		if (body?.description !== undefined) org.description = body.description;
		return org;
	});

	r.delete('/admin/organizations/:id', ({ params }) => {
		const index = orgs.findIndex((o) => o.id === params.id);
		if (index < 0) return notFound('Organization not found');
		orgs.splice(index, 1);
		return { success: true };
	});

	r.get('/admin/organizations/:id/quota', ({ params }) =>
		orgs.some((o) => o.id === params.id) ? quotaView(params.id) : notFound()
	);

	r.patch('/admin/organizations/:id/quota', ({ params, body }) => {
		if (!orgs.some((o) => o.id === params.id)) return notFound();
		const next = {
			cpuLimitMilli: body?.cpuLimitMilli ?? null,
			memoryLimitBytes: body?.memoryLimitBytes ?? null,
			maxPods: body?.maxPods ?? null,
			maxServices: body?.maxServices ?? null,
			defaultPodCpuMilli: body?.defaultPodCpuMilli ?? null,
			defaultPodMemoryBytes: body?.defaultPodMemoryBytes ?? null
		};
		const group = groupOf(params.id);
		for (const o of group.length ? group : [{ id: params.id }]) {
			Object.assign(quotaOf(o.id), next);
		}
		return quotaView(params.id);
	});

	r.post('/admin/organizations/:id/quota/connect', ({ params, body }) => {
		if (params.id === body?.otherOrgId) {
			return reply(403, {
				statusCode: 403,
				message: "You can't connect an organization to itself"
			});
		}
		const primary = quotaOf(params.id);
		const other = quotaOf(body?.otherOrgId);
		const group = primary.quotaGroupId ?? other.quotaGroupId ?? freshId();
		const joining = new Set([params.id, body.otherOrgId]);
		for (const o of orgs) {
			const q = quotaOf(o.id);
			if (
				q.quotaGroupId &&
				(q.quotaGroupId === primary.quotaGroupId || q.quotaGroupId === other.quotaGroupId)
			)
				joining.add(o.id);
		}
		for (const id of joining) {
			Object.assign(quotaOf(id), { ...primary, quotaGroupId: group });
		}
		return { quotaGroupId: group, orgIds: [...joining] };
	});

	r.post('/admin/organizations/:id/quota/disconnect', ({ params }) => {
		const group = quotaOf(params.id).quotaGroupId;
		if (!group) return { quotaGroupId: null };
		quotaOf(params.id).quotaGroupId = null;
		const remaining = orgs.filter((o) => quotaOf(o.id).quotaGroupId === group);
		if (remaining.length <= 1) {
			for (const o of remaining) quotaOf(o.id).quotaGroupId = null;
		}
		return { quotaGroupId: null };
	});

	const seen = () => new Date(Date.now() - 40_000).toISOString();
	const nodes: AdminNode[] = [
		{
			id: uid('node:barn'),
			name: 'barn',
			schedulable: true,
			notes: null,
			cpuCapacity: '32',
			memoryCapacity: '131804476Ki',
			labels: {
				...STANDARD_LABELS('barn', 'hel1-dc2'),
				'orchard.io/pool': 'general'
			},
			taints: [],
			lastSeenAt: seen(),
			usage: { cpuMilli: 14_250, memoryBytes: 58 * GIB, pods: 86 }
		},
		{
			id: uid('node:house'),
			name: 'house',
			schedulable: true,
			notes: null,
			cpuCapacity: '48',
			memoryCapacity: '263602172Ki',
			labels: {
				...STANDARD_LABELS('house', 'hel1-dc2'),
				'node-role.kubernetes.io/control-plane': '',
				'orchard.io/pool': 'builders'
			},
			taints: [{ key: 'orchard.io/pool', value: 'builders', effect: 'NoSchedule' }],
			lastSeenAt: seen(),
			usage: { cpuMilli: 42_800, memoryBytes: 151 * GIB, pods: 112 }
		},
		{
			id: uid('node:shed'),
			name: 'shed',
			schedulable: true,
			notes: null,
			cpuCapacity: '8000m',
			memoryCapacity: '32Gi',
			labels: STANDARD_LABELS('shed', 'fsn1-dc14'),
			taints: [],
			lastSeenAt: seen(),
			usage: { cpuMilli: 7_100, memoryBytes: 17 * GIB, pods: 31 }
		},
		{
			id: uid('node:orchard-worker-gpu-fsn1-a1b2c3'),
			name: 'orchard-worker-gpu-fsn1-a1b2c3',
			schedulable: false,
			notes: 'Waiting on a drive swap',
			cpuCapacity: '16',
			memoryCapacity: '65901536Ki',
			labels: {
				...STANDARD_LABELS('orchard-worker-gpu-fsn1-a1b2c3', 'fsn1-dc14'),
				'orchard.io/pool': 'gpu'
			},
			taints: [
				{ key: 'nvidia.com/gpu', value: null, effect: 'NoSchedule' },
				{ key: 'orchard.io/pool', value: 'gpu', effect: 'NoExecute' }
			],
			lastSeenAt: seen(),
			usage: { cpuMilli: 0, memoryBytes: 0, pods: 0 }
		},
		{
			id: uid('node:unmeasured'),
			name: 'loft',
			schedulable: true,
			notes: null,
			cpuCapacity: null,
			memoryCapacity: null,
			labels: {},
			taints: [],
			lastSeenAt: seen(),
			usage: { cpuMilli: 250, memoryBytes: 512 * MIB, pods: 2 }
		}
	];

	const assignments: Assignment[] = [
		{
			id: freshId(),
			nodeId: nodes[1].id,
			organizationId: orgs[0].id,
			mode: 'allow',
			cpuLimit: '8',
			memoryLimit: '32Gi',
			maxServices: 20,
			createdAt: new Date().toISOString()
		},
		{
			id: freshId(),
			nodeId: nodes[1].id,
			organizationId: orgs[3].id,
			mode: 'deny',
			cpuLimit: null,
			memoryLimit: null,
			maxServices: null,
			createdAt: new Date().toISOString()
		}
	];

	const nodeRow = (node: AdminNode) => ({
		...node,
		createdAt: node.lastSeenAt,
		updatedAt: node.lastSeenAt,
		_count: { assignments: assignments.filter((a) => a.nodeId === node.id).length }
	});

	const nodeDetail = (node: AdminNode) => ({
		...node,
		assignments: assignments
			.filter((a) => a.nodeId === node.id)
			.map((a) => {
				const org = orgs.find((o) => o.id === a.organizationId);
				return {
					...a,
					organization: org
						? { id: org.id, name: org.name, slug: org.slug, avatarUrl: org.avatarUrl }
						: { id: a.organizationId, name: 'Deleted', slug: 'deleted', avatarUrl: null }
				};
			}),
		perOrgUsage: node.usage.pods
			? [
					{
						orgId: orgs[0].id,
						cpuMilli: node.usage.cpuMilli,
						memBytes: node.usage.memoryBytes,
						pods: node.usage.pods
					}
				]
			: []
	});

	r.get('/admin/nodes', () => {
		if (scenario.nodes === 'error') return failure();
		return scenario.nodes === 'empty' ? [] : nodes.map(nodeRow);
	});

	r.post('/admin/nodes/sync', () => {
		if (scenario.nodes === 'empty') scenario.nodes = 'ok';
		for (const node of nodes) node.lastSeenAt = new Date().toISOString();
		return { synced: nodes.length };
	});

	r.get('/admin/nodes/:id', ({ params }) => {
		const node = nodes.find((n) => n.id === params.id);
		return node ? nodeDetail(node) : notFound('Node not found');
	});

	r.patch('/admin/nodes/:id', ({ params, body }) => {
		const node = nodes.find((n) => n.id === params.id);
		if (!node) return notFound('Node not found');
		if (body?.schedulable !== undefined) node.schedulable = body.schedulable;
		if (body?.notes !== undefined) node.notes = body.notes;
		return nodeRow(node);
	});

	r.patch('/admin/nodes/:id/taints', ({ params, body }) => {
		const node = nodes.find((n) => n.id === params.id);
		if (!node) return notFound('Node not found');
		const taints = body?.taints as Taint[] | undefined;
		if (!Array.isArray(taints)) {
			return reply(400, { statusCode: 400, message: 'taints must be an array' });
		}
		node.taints = taints.map((t) => ({ key: t.key, value: t.value ?? null, effect: t.effect }));
		return { success: true };
	});

	r.patch('/admin/nodes/:id/labels', ({ params, body }) => {
		const node = nodes.find((n) => n.id === params.id);
		if (!node) return notFound('Node not found');
		for (const [key, value] of Object.entries((body?.labels ?? {}) as Record<string, unknown>)) {
			if (value === null) delete node.labels[key];
			else node.labels[key] = String(value);
		}
		return { success: true };
	});

	r.post('/admin/nodes/:id/assignments/:orgId', ({ params, body }) => {
		if (!nodes.some((n) => n.id === params.id)) return notFound('Node not found');
		if (!orgs.some((o) => o.id === params.orgId)) return notFound('Organization not found');
		const existing = assignments.find(
			(a) => a.nodeId === params.id && a.organizationId === params.orgId
		);
		const next: Assignment = {
			id: existing?.id ?? freshId(),
			nodeId: params.id,
			organizationId: params.orgId,
			mode: body?.mode ?? existing?.mode ?? 'allow',
			cpuLimit: body?.cpuLimit ?? existing?.cpuLimit ?? null,
			memoryLimit: body?.memoryLimit ?? existing?.memoryLimit ?? null,
			maxServices: body?.maxServices ?? existing?.maxServices ?? null,
			createdAt: existing?.createdAt ?? new Date().toISOString()
		};
		if (existing) Object.assign(existing, next);
		else assignments.unshift(next);
		return next;
	});

	r.delete('/admin/nodes/:id/assignments/:orgId', ({ params }) => {
		const index = assignments.findIndex(
			(a) => a.nodeId === params.id && a.organizationId === params.orgId
		);
		if (index >= 0) assignments.splice(index, 1);
		return { success: true };
	});

	const pools: NodePool[] = [
		{
			id: uid('pool:builders'),
			name: 'Builders',
			slug: 'builders',
			description: 'Fast disks for image builds',
			nodeSelector: [{ key: 'orchard.io/pool', operator: 'In', values: ['builders'] }],
			tolerations: [
				{ key: 'orchard.io/pool', operator: 'Equal', value: 'builders', effect: 'NoSchedule' }
			],
			affinityMode: 'required',
			userSelectable: false,
			_count: { deployments: 0, jobs: 3, databases: 0 }
		},
		{
			id: uid('pool:background'),
			name: 'Background',
			slug: 'background',
			description: null,
			nodeSelector: [{ key: 'orchard.io/pool', operator: 'In', values: ['general'] }],
			tolerations: [],
			affinityMode: 'preferred',
			userSelectable: true,
			_count: { deployments: 12, jobs: 4, databases: 1 }
		},
		{
			id: uid('pool:gpu'),
			name: 'GPU',
			slug: 'gpu',
			description: 'Nodes with an NVIDIA card',
			nodeSelector: [
				{ key: 'orchard.io/pool', operator: 'In', values: ['gpu'] },
				{ key: 'nvidia.com/gpu.present', operator: 'Exists' }
			],
			tolerations: [
				{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
				{ key: 'orchard.io/pool', operator: 'Equal', value: 'gpu' }
			],
			affinityMode: 'required',
			userSelectable: true,
			_count: { deployments: 1, jobs: 0, databases: 0 }
		}
	];

	r.get('/admin/node-pools', () => {
		if (scenario.pools === 'error') return failure();
		return scenario.pools === 'empty' ? [] : pools;
	});

	r.post('/admin/node-pools', ({ body }) => {
		const slug = String(body?.name ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
		if (!slug) return reply(400, { statusCode: 400, message: 'Name is required' });
		if (pools.some((p) => p.slug === slug)) {
			return reply(409, { statusCode: 409, message: 'A pool with that name already exists' });
		}
		const pool: NodePool = {
			id: freshId(),
			name: body.name,
			slug,
			description: body.description ?? null,
			nodeSelector: body.nodeSelector ?? [],
			tolerations: body.tolerations ?? [],
			affinityMode: body.affinityMode ?? 'preferred',
			userSelectable: !!body.userSelectable,
			_count: { deployments: 0, jobs: 0, databases: 0 }
		};
		pools.push(pool);
		if (scenario.pools === 'empty') scenario.pools = 'ok';
		return pool;
	});

	r.patch('/admin/node-pools/:id', ({ params, body }) => {
		const pool = pools.find((p) => p.id === params.id);
		if (!pool) return notFound('Node pool not found');
		Object.assign(pool, body ?? {});
		return pool;
	});

	r.delete('/admin/node-pools/:id', ({ params }) => {
		const index = pools.findIndex((p) => p.id === params.id);
		if (index < 0) return notFound('Node pool not found');
		pools.splice(index, 1);
		return { success: true };
	});

	const scheduling: { dbValue: boolean; envOverride: boolean | null } = {
		dbValue: false,
		envOverride: null
	};
	const schedulingView = () => ({
		enabled: scheduling.envOverride ?? scheduling.dbValue,
		dbValue: scheduling.dbValue,
		envOverride: scheduling.envOverride
	});

	r.post('/__mock/admin/userspace-scheduling', ({ body }) => {
		scheduling.envOverride = body?.envOverride ?? null;
		return schedulingView();
	});
	r.get('/admin/instance-settings/userspace-scheduling', () => schedulingView());
	r.patch('/admin/instance-settings/userspace-scheduling', ({ body }) => {
		scheduling.dbValue = !!body?.enabled;
		return schedulingView();
	});
}
