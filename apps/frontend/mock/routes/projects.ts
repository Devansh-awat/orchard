import { randomBytes } from 'node:crypto';
import { TEMPLATES, templateRow } from '../templates.ts';
import { templateSpec } from '../template-params.ts';
import { ago, freshId, sha, slugify, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import {
	access,
	creator,
	environment,
	ingress,
	projectMember,
	projectMeta,
	userRow
} from '../serialize.ts';
import type { Store } from '../store.ts';

type MockInvite = {
	id: string;
	email: string;
	createdAt: string;
	expiresAt: string;
	projectRole: { name: string };
};

const INVITES = new Map<string, MockInvite[]>();
const STACK_EDITS = new Map<
	string,
	{ name?: string; autoDeploy?: boolean; deleted?: boolean; redeployedAt?: number }
>();

import type { MockEnvironment, MockProject } from '../types.ts';

function projectDetail(store: Store, p: MockProject) {
	const o = store.org(p.organizationId)!;
	const owner = store.user(p.ownerId);
	return {
		...projectMeta(store, p),
		organization: {
			id: o.id,
			name: o.name,
			slug: o.slug,
			avatarUrl: o.avatarUrl,
			plan: o.plan
		},
		creator: owner ? userRow(owner) : null,
		deployments: store.deploymentsOf(p.id).map((d) => ({
			id: d.id,
			name: d.name,
			displayName: d.displayName,
			status: d.status,
			buildStatus: d.buildStatus,
			buildStep: d.buildStep,
			replicas: d.replicas,
			stopped: d.stopped,
			image: d.image,
			githubRepo: d.githubRepo,
			githubBranch: d.githubBranch,
			projectId: d.projectId,
			environmentId: d.environmentId,
			createdAt: d.createdAt,
			updatedAt: d.updatedAt,
			creator: creator(store.user(d.creatorId)),
			imageHistory: store
				.buildsOf(d.id)
				.slice(0, 1)
				.map((b) => ({
					buildStartedAt: b.buildStartedAt,
					buildCompletedAt: b.buildCompletedAt,
					commitAuthorName: b.commitAuthorName,
					commitAuthorUsername: b.commitAuthorUsername,
					triggeredBy: creator(store.user(b.triggeredById))
				})),
			services: [],
			ingresses: ingress(d),
			_count: { pods: d.stopped ? 0 : d.replicas, services: 1 }
		})),
		databases: store.databasesOf(p.id).map((db) => ({
			id: db.id,
			name: db.name,
			dbName: db.dbName,
			status: db.status,
			mode: db.mode,
			type: db.engine,
			createdAt: db.createdAt,
			updatedAt: db.updatedAt,
			namespace: null,
			clusterName: `${db.name}-cluster`,
			environmentId: db.environmentId
		})),
		templateInstances: [],
		ingresses: store
			.deploymentsOf(p.id)
			.flatMap(ingress)
			.map((i) => ({ id: i.id, name: i.name, host: i.host, tlsSecretName: i.tlsSecretName })),
		pendingInvitations: INVITES.get(p.id) ?? [],
		pendingTransfer: null,
		currentUserRole: access(store, p)
	};
}

type MockStackService = [name: string, status: string];

type MockStackSeed = {
	name: string;
	status: string;
	buildStatus: string;
	repo: string | null;
	branch?: string;
	path?: string;
	autoDeploy?: boolean;
	lastError?: string;
	updated: number;
	services: MockStackService[];
};

const COMPOSE_STACKS: Record<string, MockStackSeed[]> = {
	terra: [
		{
			name: 'arcade',
			status: 'active',
			buildStatus: 'succeeded',
			repo: 'hackclub/arcade',
			branch: 'main',
			path: 'docker-compose.yml',
			autoDeploy: true,
			updated: 42,
			services: [
				['web', 'running'],
				['api', 'running'],
				['redis', 'running']
			]
		},
		{
			name: 'leaderboard',
			status: 'updating',
			buildStatus: 'building',
			repo: 'hackclub/terra-leaderboard',
			branch: 'next',
			path: 'deploy/compose.yaml',
			updated: 1,
			services: [
				['web', 'deploying'],
				['worker', 'running'],
				['scheduler', 'running']
			]
		},
		{
			name: 'metrics',
			status: 'failed',
			buildStatus: 'none',
			repo: null,
			lastError: 'grafana: image grafana/grafana:11.9 not found',
			updated: 60 * 26,
			services: [
				['prometheus', 'running'],
				['grafana', 'failed'],
				['loki', 'running'],
				['promtail', 'running'],
				['alertmanager', 'running'],
				['node-exporter', 'running']
			]
		}
	]
};

const SERVICE_IMAGES: Record<string, string> = {
	redis: 'redis:7-alpine',
	prometheus: 'prom/prometheus:v2.53.0',
	grafana: 'grafana/grafana:11.9',
	loki: 'grafana/loki:3.1.0',
	promtail: 'grafana/promtail:3.1.0',
	alertmanager: 'prom/alertmanager:v0.27.0',
	'node-exporter': 'prom/node-exporter:v1.8.1'
};

function serviceImage(stack: string, service: string) {
	return SERVICE_IMAGES[service] ?? `ghcr.io/hackclub/${stack}-${service}:latest`;
}

function composeYamlFor(s: MockStackSeed) {
	const lines = ['services:'];
	for (const [name] of s.services) {
		lines.push(`  ${name}:`);
		if (SERVICE_IMAGES[name]) lines.push(`    image: ${SERVICE_IMAGES[name]}`);
		else lines.push('    build: .', `    command: pnpm start:${name}`);
		if (name === 'web' || name === 'grafana') {
			lines.push(
				'    ports:',
				`      - "${name === 'web' ? 3000 : 3001}:${name === 'web' ? 3000 : 3000}"`
			);
		}
		if (!SERVICE_IMAGES[name]) {
			lines.push(
				'    environment:',
				'      DATABASE_URL: ${DATABASE_URL}',
				'      REDIS_URL: redis://redis:6379'
			);
		}
		if (name === 'web' || name === 'api') lines.push('    depends_on:', '      - redis');
	}
	return lines.join('\n') + '\n';
}

function composeStacks(store: Store, p: MockProject) {
	const existing = store.deploymentsOf(p.id);
	return (COMPOSE_STACKS[p.slug] ?? []).flatMap((s) => {
		const id = uid(`compose:${p.id}:${s.name}`);
		const edit = STACK_EDITS.get(id) ?? {};
		if (edit.deleted) return [];
		const autoDeploy = edit.autoDeploy ?? s.autoDeploy ?? false;
		const head = edit.redeployedAt ? `${id}:${edit.redeployedAt}` : `${id}:head`;
		return {
			id,
			projectId: p.id,
			environmentId: null,
			name: edit.name ?? s.name,
			composeYaml: composeYamlFor(s),
			status: s.status,
			lastError: s.lastError ?? null,
			githubRepo: s.repo ? `https://github.com/${s.repo}` : null,
			githubBranch: s.branch ?? null,
			composePath: s.path ?? null,
			githubInstallationId: null,
			autoDeployEnabled: autoDeploy,
			autoDeployBranch: autoDeploy ? (s.branch ?? null) : null,
			lastCommitSha: s.repo ? sha(head) : null,
			buildStatus: s.buildStatus,
			buildLogs: '',
			createdBy: p.ownerId,
			createdAt: ago(s.updated + 60 * 24 * 9),
			updatedAt: ago(s.updated),
			deployments: s.services.map(([name, status]) => {
				const linked = existing.find((d) => d.name === name);
				return {
					id: linked?.id ?? uid(`compose:${id}:${name}`),
					name: linked?.name ?? `${s.name}-${name}`,
					status,
					image: serviceImage(s.name, name),
					replicas: 1,
					buildStatus: status === 'deploying' ? 'building' : 'succeeded',
					buildStep: status === 'deploying' ? 'pushing' : null,
					createdAt: ago(s.updated + 60 * 24 * 9),
					composeServiceName: name
				};
			})
		};
	});
}

export function projectRoutes(r: Router, { store }: MockContext) {
	const find = (id: string) => store.project(id);

	r.get('/projects', ({ query }) => {
		const orgId = query.get('orgId');
		const ids = new Set(store.myOrgs().map((o) => o.id));
		return store.state.projects
			.filter((p) => (orgId ? p.organizationId === orgId : ids.has(p.organizationId)))
			.map((p) => projectMeta(store, p));
	});

	r.get('/projects/by-slugs/:org/:project', ({ params }) => {
		const p = store.projectBySlugs(params.org, params.project);
		return p ? projectDetail(store, p) : notFound('Project not found');
	});

	r.get('/projects/slug/:slug', ({ params, query }) => {
		const orgId = query.get('orgId');
		const p = store.state.projects.find(
			(x) => x.slug === params.slug && (!orgId || x.organizationId === orgId)
		);
		return p ? projectMeta(store, p) : notFound('Project not found');
	});

	r.get('/projects/:id', ({ params }) => {
		const p = find(params.id);
		return p ? projectDetail(store, p) : notFound('Project not found');
	});

	r.post('/projects', ({ body }) => {
		const o = store.org(body?.organizationId ?? '') ?? store.myOrgs()[0];
		const name = String(body?.name ?? 'new-project');
		const slug = slugify(body?.slug ?? name) || 'project';
		const now = new Date().toISOString();
		const p: MockProject = {
			id: freshId(),
			organizationId: o.id,
			name,
			slug,
			description: body?.description ?? null,
			icon: body?.icon ?? null,
			backgroundImage: body?.backgroundImage ?? null,
			ownerId: store.state.meId,
			memberIds: [store.state.meId],
			createdAt: now,
			updatedAt: now
		};
		store.state.projects.push(p);
		store.state.environments.push({
			id: uid(`env:${p.id}:production`),
			projectId: p.id,
			name: 'Production',
			slug: 'production',
			namespace: `${o.slug}-${slug}`,
			isDefault: true,
			isProduction: true,
			cpuLimitMilli: null,
			memoryLimitBytes: null,
			maxPods: null,
			maxServices: null,
			sharedVars: [],
			createdAt: now,
			updatedAt: now
		});
		store.emitOrg(o.id, 'project.changed', p.id);
		return projectDetail(store, p);
	});

	r.patch('/projects/:id', ({ params, body }) => {
		const p = find(params.id);
		if (!p) return notFound();
		for (const key of ['name', 'description', 'icon', 'backgroundImage'] as const) {
			if (body?.[key] !== undefined) (p as any)[key] = body[key];
		}
		store.touch(p);
		store.emit('project.changed', p.id, p.id);
		return projectDetail(store, p);
	});

	r.delete('/projects/:id', ({ params }) => {
		const p = find(params.id);
		if (!p) return notFound();
		for (const d of store.deploymentsOf(p.id)) store.removeDeployment(d.id);
		for (const db of store.databasesOf(p.id)) store.removeDatabase(db.id);
		store.state.projects = store.state.projects.filter((x) => x.id !== p.id);
		store.emitOrg(p.organizationId, 'project.changed', p.id, { deleted: true });
		return { ok: true };
	});

	const stackById = (id: string) => {
		for (const p of store.state.projects) {
			const stack = composeStacks(store, p).find((s) => s.id === id);
			if (stack) return stack;
		}
		return undefined;
	};
	const editStack = (id: string, change: NonNullable<ReturnType<typeof STACK_EDITS.get>>) => {
		const stack = stackById(id);
		if (!stack) return notFound('Compose stack not found');
		STACK_EDITS.set(id, { ...STACK_EDITS.get(id), ...change });
		store.emit('project.changed', stack.projectId, stack.projectId);
		return stackById(id) ?? { ok: true };
	};

	r.get(
		'/compose-stacks/:id',
		({ params }) => stackById(params.id) ?? notFound('Compose stack not found')
	);

	r.post('/compose-stacks/:id/redeploy', ({ params }) => {
		const stack = stackById(params.id);
		if (!stack) return notFound('Compose stack not found');
		if (!stack.githubRepo) {
			return reply(400, { message: 'This stack is not linked to a GitHub source' });
		}
		return editStack(params.id, { redeployedAt: Date.now() });
	});

	r.put('/compose-stacks/:id/auto-deploy', ({ params, body }) =>
		editStack(params.id, { autoDeploy: Boolean(body?.enabled) })
	);

	r.patch('/compose-stacks/:id/name', ({ params, body }) => {
		const name = String(body?.name ?? '').trim();
		if (!name) return reply(400, { message: 'Name is required' });
		return editStack(params.id, { name });
	});

	r.delete('/compose-stacks/:id', ({ params }) => {
		if (!stackById(params.id)) return notFound('Compose stack not found');
		editStack(params.id, { deleted: true });
		return { ok: true };
	});

	r.get('/projects/:id/compose-stacks', ({ params }) => {
		const p = find(params.id);
		return p ? composeStacks(store, p) : notFound();
	});
	r.get('/projects/:id/anomalies', ({ params }) => ({
		anomalies: store
			.deploymentsOf(params.id)
			.filter((d) => d.crash)
			.map((d) => {
				const o = store.orgOfProject(d.projectId)!;
				return {
					id: `crash:${d.id}`,
					kind: 'crashloop',
					severity: 'error',
					resource: { kind: 'deployment', id: d.id, name: d.name },
					title: `${d.name} keeps crashing`,
					detail: d.crash!.message,
					since: d.updatedAt,
					href: `/${o.slug}/deployments/${d.id}`,
					action: { label: 'Raise memory', href: `/${o.slug}/deployments/${d.id}?tab=resources` }
				};
			})
	}));
	r.get('/projects/:id/registry-credentials', () => []);
	r.get('/projects/:id/members', ({ params }) => {
		const p = find(params.id);
		return p ? p.memberIds.map((id) => projectMember(store, p, id)) : notFound();
	});
	r.post('/projects/:id/members', ({ params, body }) => {
		const p = find(params.id);
		if (!p) return notFound();
		const u = store.state.users.find((x) => x.email === body?.email);
		if (!u) {
			const list = INVITES.get(p.id) ?? [];
			if (!list.some((i) => i.email === body?.email)) {
				list.push({
					id: freshId(),
					email: String(body?.email),
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
					projectRole: { name: String(body?.role ?? 'member') }
				});
				INVITES.set(p.id, list);
			}
			store.emit('membership.changed', p.id, '');
			return { invited: true };
		}
		if (!p.memberIds.includes(u.id)) p.memberIds.push(u.id);
		store.emit('membership.changed', p.id, u.id);
		return { invited: false };
	});
	r.delete('/projects/:id/invitations/:invitationId', ({ params }) => {
		INVITES.set(
			params.id,
			(INVITES.get(params.id) ?? []).filter((i) => i.id !== params.invitationId)
		);
		return { ok: true };
	});
	r.delete('/projects/:id/members/:memberId', ({ params }) => {
		const p = find(params.id);
		if (!p) return notFound();
		p.memberIds = p.memberIds.filter((id) => uid(`pm:${p.id}:${id}`) !== params.memberId);
		store.emit('membership.changed', p.id);
		return { ok: true };
	});

	r.get('/projects/:id/environments', ({ params }) =>
		store.state.environments
			.filter((e) => e.projectId === params.id)
			.map((e) => environment(store, e))
	);
	r.post('/projects/:id/environments', ({ params, body }) => {
		const p = find(params.id);
		if (!p) return notFound();
		const o = store.org(p.organizationId)!;
		const now = new Date().toISOString();
		const slug = slugify(body?.slug ?? body?.name ?? 'staging');
		const e: MockEnvironment = {
			id: freshId(),
			projectId: p.id,
			name: body?.name ?? slug,
			slug,
			namespace: `${o.slug}-${p.slug}-${slug}`,
			isDefault: false,
			isProduction: Boolean(body?.isProduction),
			cpuLimitMilli: null,
			memoryLimitBytes: null,
			maxPods: null,
			maxServices: null,
			sharedVars: [],
			createdAt: now,
			updatedAt: now
		};
		store.state.environments.push(e);
		store.emit('environment.changed', p.id, e.id);
		return environment(store, e);
	});
	const env = (id: string) => store.state.environments.find((e) => e.id === id);
	r.patch('/environments/:id', ({ params, body }) => {
		const e = env(params.id);
		if (!e) return notFound();
		Object.assign(e, body ?? {}, { updatedAt: new Date().toISOString() });
		store.emit('environment.changed', e.projectId, e.id);
		return environment(store, e);
	});
	r.delete('/environments/:id', ({ params }) => {
		const e = env(params.id);
		if (!e) return notFound();
		if (e.isDefault) return reply(400, { message: 'The default environment cannot be deleted' });
		store.state.environments = store.state.environments.filter((x) => x.id !== e.id);
		store.emit('environment.changed', e.projectId, e.id);
		return { ok: true };
	});
	r.post('/environments/:id/set-default', ({ params }) => {
		const e = env(params.id);
		if (!e) return notFound();
		for (const other of store.state.environments) {
			if (other.projectId === e.projectId) other.isDefault = other.id === e.id;
		}
		store.emit('environment.changed', e.projectId, e.id);
		return environment(store, e);
	});
	r.get('/environments/:id/shared-vars', ({ params }) => {
		const e = env(params.id);
		if (!e) return notFound();
		return e.sharedVars.map((v) => ({
			key: v.key,
			value: v.secret ? null : v.value,
			secret: v.secret
		}));
	});
	r.put('/environments/:id/shared-vars', ({ params, body }) => {
		const e = env(params.id);
		if (!e) return notFound();
		const prev = new Map(e.sharedVars.map((v) => [v.key, v]));
		e.sharedVars = (body?.vars ?? []).map((v: any) => ({
			key: String(v.key),
			value: v.value ?? prev.get(v.key)?.value ?? '',
			secret: Boolean(v.secret)
		}));
		store.emit('sharedvars.changed', e.projectId, e.id);
		return { warnings: [] };
	});

	r.get('/templates', () => TEMPLATES.map(templateRow));
	r.get('/templates/:id', ({ params }) => {
		const i = TEMPLATES.findIndex((t) => `tpl_${t.name}` === params.id || t.name === params.id);
		if (i < 0) return notFound('Template not found');
		const spec = templateSpec(TEMPLATES[i]);
		return {
			...templateRow(TEMPLATES[i], i),
			parameters: spec.parameters,
			resources: spec.resources
		};
	});

	const instances = new Map<string, TemplateInstance>();

	const live = (inst: TemplateInstance): TemplateInstance => {
		if (Date.now() - new Date(inst.createdAt).getTime() < 8000) return inst;
		return {
			...inst,
			status: 'running',
			deployments: inst.deployments.map((d) => ({ ...d, status: 'running' })),
			databases: inst.databases.map((d) => ({ ...d, status: 'running' }))
		};
	};

	r.post('/projects/:projectId/template-instances', ({ params, body }) => {
		const t = TEMPLATES.find((x) => `tpl_${x.name}` === body?.templateId);
		if (!t) return notFound('Template not found');
		const spec = templateSpec(t);
		const values: Record<string, unknown> = { ...(body?.parameters ?? {}) };
		for (const p of spec.parameters) {
			if (p.type === 'secret' && !values[p.name]) {
				values[p.name] = randomBytes(p.validation?.bytes ?? 16).toString('hex');
			}
			if (p.required && (values[p.name] === undefined || values[p.name] === '')) {
				return reply(400, { statusCode: 400, message: `${p.displayName} is required` });
			}
		}
		const name = String(values.appName ?? t.name);
		const host =
			typeof values.domain === 'string' && values.domain ? values.domain : `${name}.orchard.my`;
		const inst: TemplateInstance = {
			id: freshId(),
			name,
			status: 'deploying',
			projectId: params.projectId,
			parameters: values,
			createdAt: new Date().toISOString(),
			template: {
				id: `tpl_${t.name}`,
				name: t.name,
				displayName: t.displayName,
				icon: t.icon ?? undefined,
				category: t.category
			},
			deployments: spec.resources
				.filter((x) => x.type === 'deployment')
				.map((x) => ({
					id: freshId(),
					name: x.name,
					status: 'deploying',
					image: `${x.name}:latest`
				})),
			databases: spec.resources
				.filter((x) => x.type === 'database')
				.map((x) => ({
					id: freshId(),
					name: x.name,
					status: 'provisioning',
					dbName: x.name.replace(/-/g, '_')
				})),
			ingresses: spec.resources
				.filter((x) => x.type === 'ingress')
				.map((x) => ({ id: freshId(), name: x.name, host, path: '/' }))
		};
		instances.set(inst.id, inst);
		return inst;
	});

	r.get('/projects/:projectId/template-instances', ({ params }) =>
		[...instances.values()].filter((i) => i.projectId === params.projectId).map(live)
	);

	r.get('/template-instances/:id', ({ params }) => {
		const inst = instances.get(params.id);
		return inst ? live(inst) : notFound('Template instance not found');
	});

	r.patch('/template-instances/:id/name', ({ params, body }) => {
		const inst = instances.get(params.id);
		if (!inst) return notFound('Template instance not found');
		if (typeof body?.name === 'string' && body.name.trim()) inst.name = body.name.trim();
		return live(inst);
	});

	r.delete('/template-instances/:id', ({ params }) => {
		instances.delete(params.id);
		return { ok: true };
	});
	r.get('/sync/:namespace', () => ({ ok: true }));
}

type TemplateInstance = {
	id: string;
	name: string;
	status: string;
	projectId: string;
	parameters: Record<string, unknown>;
	createdAt: string;
	template: { id: string; name: string; displayName: string; icon?: string; category?: string };
	deployments: { id: string; name: string; status: string; image?: string }[];
	databases: { id: string; name: string; status: string; dbName: string }[];
	ingresses: { id: string; name: string; host: string; path: string }[];
};
