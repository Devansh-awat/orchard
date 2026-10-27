import { freshId, slugify, uid } from '../ids.ts';
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
		pendingInvitations: [],
		pendingTransfer: null,
		currentUserRole: access(store, p)
	};
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

	r.get('/projects/:id/compose-stacks', () => []);
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
		if (!u) return { invited: true };
		if (!p.memberIds.includes(u.id)) p.memberIds.push(u.id);
		store.emit('membership.changed', p.id, u.id);
		return { invited: false };
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

	r.get('/templates', () => []);
	r.get('/sync/:namespace', () => ({ ok: true }));
}
