import { freshId } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import type { Store } from '../store.ts';
import type { MockJob, MockJobRun, MockJobStep } from '../types.ts';

function nextRun(cron: string | null, enabled: boolean) {
	if (!cron || !enabled) return null;
	const m = /^\*\/(\d+) /.exec(cron);
	const every = m ? Number(m[1]) * 60_000 : 3_600_000 * 6;
	return new Date(Math.ceil(Date.now() / every) * every).toISOString();
}

function runSummary(r: MockJobRun) {
	return {
		id: r.id,
		number: r.number,
		status: r.status,
		trigger: r.trigger,
		startedAt: r.startedAt,
		finishedAt: r.finishedAt,
		createdAt: r.createdAt
	};
}

function runDetail(store: Store, r: MockJobRun) {
	const job = store.job(r.jobId);
	const by = store.user(r.triggeredById);
	return {
		...runSummary(r),
		jobId: r.jobId,
		jobName: job?.name,
		currentStepOrder: r.currentStepOrder,
		errorMessage: r.errorMessage,
		scheduledFor: r.scheduledFor,
		triggeredBy: by
			? { id: by.id, username: by.username, name: `${by.firstName} ${by.lastName}` }
			: null,
		steps: r.steps.map(({ logs: _logs, ...s }) => s)
	};
}

export function jobRow(store: Store, j: MockJob, withSteps = false) {
	const p = store.project(j.projectId)!;
	const runs = store.runsOf(j.id);
	return {
		id: j.id,
		name: j.name,
		description: j.description,
		projectId: j.projectId,
		projectName: p.name,
		projectSlug: p.slug,
		organizationId: p.organizationId,
		scheduleCron: j.scheduleCron,
		timeZone: j.timeZone,
		enabled: j.enabled,
		concurrencyPolicy: j.concurrencyPolicy,
		runTimeoutSeconds: j.runTimeoutSeconds,
		stepCount: j.steps.length,
		stepSummaries: j.steps.map((s) => ({ name: s.name, type: s.type })),
		lastRun: runs[0] ? runSummary(runs[0]) : null,
		recentRuns: runs.slice(0, 10).map((r) => ({
			id: r.id,
			number: r.number,
			status: r.status,
			startedAt: r.startedAt,
			finishedAt: r.finishedAt
		})),
		nextRunAt: nextRun(j.scheduleCron, j.enabled),
		...(withSteps ? { steps: j.steps } : {}),
		createdAt: j.createdAt,
		updatedAt: j.updatedAt
	};
}

function toStep(raw: any, i: number): MockJobStep {
	return {
		id: freshId(),
		stepOrder: i,
		name: String(raw?.name ?? `step-${i + 1}`),
		type: raw?.type ?? 'script',
		deploymentId: raw?.deploymentId || null,
		image: raw?.image || null,
		command: raw?.command || null,
		script: raw?.script || null,
		scriptRuntime: raw?.scriptRuntime || null,
		envVars: Array.isArray(raw?.envVars) ? raw.envVars : [],
		cpuRequestMilli: raw?.cpuRequestMilli ?? null,
		memoryRequestBytes: raw?.memoryRequestBytes ?? null,
		timeoutSeconds: Number(raw?.timeoutSeconds ?? 600),
		retries: Number(raw?.retries ?? 0)
	};
}

export function jobRoutes(r: Router, { store }: MockContext) {
	const changed = (j: MockJob) => {
		j.updatedAt = new Date().toISOString();
		store.emit('job.changed', j.projectId, j.id);
	};

	r.get('/organizations/:orgId/jobs', ({ params }) => {
		const o = store.org(params.orgId);
		if (!o) return notFound();
		const pids = new Set(store.projectsOf(o.id).map((p) => p.id));
		return store.state.jobs.filter((j) => pids.has(j.projectId)).map((j) => jobRow(store, j));
	});
	r.get('/projects/:id/jobs', ({ params }) =>
		store.state.jobs.filter((j) => j.projectId === params.id).map((j) => jobRow(store, j))
	);
	r.get('/jobs/:id', ({ params }) => {
		const j = store.job(params.id);
		return j ? jobRow(store, j, true) : notFound('Job not found');
	});
	r.get('/jobs/:id/runs', ({ params, query }) => {
		const j = store.job(params.id);
		if (!j) return notFound();
		const all = store.runsOf(j.id);
		const cursor = query.get('cursor');
		const from = cursor ? all.findIndex((x) => x.id === cursor) + 1 : 0;
		const page = all.slice(from, from + 20);
		return {
			runs: page.map((x) => runDetail(store, x)),
			nextCursor: from + 20 < all.length ? page.at(-1)!.id : null
		};
	});
	r.post('/jobs/:id/runs', ({ params }) => {
		const j = store.job(params.id);
		if (!j) return notFound();
		if (j.concurrencyPolicy === 'forbid' && store.runsOf(j.id).some((x) => !x.finishedAt)) {
			return reply(409, { message: 'A run is already in progress' });
		}
		const run = store.runJob(j.id)!;
		return runDetail(store, run);
	});
	r.patch('/jobs/:id', ({ params, body }) => {
		const j = store.job(params.id);
		if (!j) return notFound();
		for (const key of [
			'name',
			'description',
			'scheduleCron',
			'timeZone',
			'enabled',
			'concurrencyPolicy',
			'runTimeoutSeconds'
		] as const) {
			if (body?.[key] !== undefined) (j as any)[key] = body[key];
		}
		changed(j);
		return jobRow(store, j, true);
	});
	r.put('/jobs/:id/steps', ({ params, body }) => {
		const j = store.job(params.id);
		if (!j) return notFound();
		j.steps = (body?.steps ?? []).map(toStep);
		changed(j);
		return jobRow(store, j, true);
	});
	r.delete('/jobs/:id', ({ params }) => {
		const j = store.job(params.id);
		if (!j) return notFound();
		store.state.jobs = store.state.jobs.filter((x) => x.id !== j.id);
		store.emit('job.changed', j.projectId, j.id, { deleted: true });
		return { ok: true };
	});
	r.post('/jobs', ({ body }) => {
		const p = store.project(body?.projectId ?? '');
		if (!p) return reply(400, { message: 'projectId is required' });
		const now = new Date().toISOString();
		const j: MockJob = {
			id: freshId(),
			projectId: p.id,
			name: String(body?.name ?? 'new-job'),
			description: body?.description ?? null,
			scheduleCron: body?.scheduleCron ?? null,
			timeZone: body?.timeZone ?? 'UTC',
			enabled: body?.enabled ?? true,
			concurrencyPolicy: body?.concurrencyPolicy ?? 'forbid',
			runTimeoutSeconds: Number(body?.runTimeoutSeconds ?? 3600),
			steps: (body?.steps ?? []).map(toStep),
			createdAt: now,
			updatedAt: now
		};
		store.state.jobs.push(j);
		changed(j);
		return jobRow(store, j, true);
	});

	const run = (id: string) => store.state.jobRuns.find((x) => x.id === id);
	r.get('/job-runs/:id', ({ params }) => {
		const x = run(params.id);
		return x ? runDetail(store, x) : notFound('Run not found');
	});
	r.get('/job-runs/:id/steps/:order/logs', ({ params }) => {
		const x = run(params.id);
		const step = x?.steps.find((s) => String(s.stepOrder) === params.order);
		if (!step) return notFound();
		return { logs: step.logs, truncated: false, live: step.status === 'running' };
	});
	r.post('/job-runs/:id/cancel', ({ params }) => {
		const x = store.cancelRun(params.id);
		return x ? runDetail(store, x) : notFound();
	});
}
