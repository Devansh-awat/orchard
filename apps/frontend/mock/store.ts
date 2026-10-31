import { podShape, scenarioOf, type PodScenario } from './scenarios.ts';
import type { EventHub, OrgEventType } from './events.ts';
import { ago, freshId, sha, uid } from './ids.ts';
import { seed } from './seed.ts';
import { allUpdateIds } from './serialize.ts';
import type {
	BuildStep,
	MockBuild,
	MockDatabase,
	MockDeployment,
	MockJob,
	MockJobRun,
	MockOrg,
	MockProject,
	MockState,
	MockUser
} from './types.ts';

const BUILD_PREFIX = [
	'=== Building image ===',
	'#1 [internal] load build definition from Dockerfile',
	'#1 transferring dockerfile: 812B done',
	'#1 DONE 0.1s',
	'#2 [internal] load metadata for docker.io/library/node:22-slim',
	'#2 DONE 0.6s',
	'#3 [base 1/6] FROM docker.io/library/node:22-slim@sha256:9b1f',
	'#3 CACHED',
	'#4 [deps 2/6] COPY package.json pnpm-lock.yaml ./',
	'#4 CACHED'
];

export const BUILD_FAILURES = {
	command: {
		at: 'building',
		error:
			'Build failed: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1',
		lines: [
			...BUILD_PREFIX,
			'#5 [deps 3/6] RUN corepack enable && pnpm install --frozen-lockfile',
			'#5 DONE 18.4s',
			'#6 [build 4/6] COPY . .',
			'#6 DONE 0.3s',
			'#7 [build 5/6] RUN pnpm build',
			'#7 4.120 vite v8.3.4 building for production...',
			'#7 9.204 ✓ 1180 modules transformed.',
			'#7 9.311 [vite:load-fallback] Could not load /app/src/lib/Chart.svelte (imported by src/routes/+page.svelte): ENOENT: no such file or directory',
			'#7 9.402 error during build:',
			'#7 ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1',
			'[ERROR] Build failed: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1'
		]
	},
	lockfile: {
		at: 'building',
		error:
			'Build failed: process "/bin/sh -c corepack enable && pnpm install --frozen-lockfile" did not complete successfully: exit code: 1',
		lines: [
			...BUILD_PREFIX,
			'#5 [deps 3/6] RUN corepack enable && pnpm install --frozen-lockfile',
			'#5 1.204 Lockfile is up to date, resolution step is skipped',
			'#5 1.388 ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
			'#5 1.389 ',
			'#5 1.389 Failure reason:',
			'#5 1.389 specifiers in the lockfile ({"svelte":"^5.38.0"}) don\'t match specs in package.json ({"svelte":"^5.41.2","zod":"^4.1.0"})',
			'#5 ERROR: process "/bin/sh -c corepack enable && pnpm install --frozen-lockfile" did not complete successfully: exit code: 1'
		]
	},
	dockerfile: {
		at: 'building',
		error:
			'Build failed: error: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory\nContainer buildkit terminated: Error - exit code 1\nContainer pusher terminated: StartError - failed to start containerd task "94fea0bf": 429',
		lines: [
			'=== Building image ===',
			'time="2026-10-29T00:18:57Z" level=warning msg="CDI setup error /etc/buildkit/cdi: failed to monitor for changes: no such file or directory"',
			'[ERROR] Build failed: error: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory'
		]
	},
	typescript: {
		at: 'building',
		error:
			'Build failed: process "/bin/sh -c npx tsc && npm prune --omit=dev" did not complete successfully: exit code: 2',
		lines: [
			...BUILD_PREFIX,
			'#5 [build 3/6] RUN npm ci',
			'#5 DONE 7.9s',
			'#6 [build 4/6] COPY src ./src',
			'#6 DONE 0.0s',
			'#7 [build 5/6] RUN npx tsc && npm prune --omit=dev',
			"#7 3.512 src/slack.ts(41,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
			'#7 3.513 src/queue.ts(12,3): error TS2554: Expected 2 arguments, but got 1.',
			'#7 ERROR: process "/bin/sh -c npx tsc && npm prune --omit=dev" did not complete successfully: exit code: 2'
		]
	},
	branch: {
		at: 'cloning',
		error: 'fatal: Remote branch {branch} not found in upstream origin',
		lines: [
			'Cloning https://github.com/{repo} (branch {branch})',
			'[ERROR] fatal: Remote branch {branch} not found in upstream origin'
		]
	}
} as const;

export type BuildFailureKind = keyof typeof BUILD_FAILURES;

const PHASES: { step: BuildStep; ms: number; lines: string[] }[] = [
	{
		step: 'queued',
		ms: 2_000,
		lines: ['Build queued', 'Waiting for a builder slot on node house']
	},
	{
		step: 'cloning',
		ms: 3_000,
		lines: [
			'Scheduling builder fc-builder-7f9c2',
			'Cloning https://github.com/{repo} (branch {branch})',
			'HEAD is now at {short} {message}'
		]
	},
	{
		step: 'building',
		ms: 8_000,
		lines: [
			...BUILD_PREFIX,
			'#5 [deps 3/6] RUN corepack enable && pnpm install --frozen-lockfile',
			'#5 12.410 Packages: +612',
			'#5 18.020 Done in 9.4s',
			'#5 DONE 18.4s',
			'#6 [build 4/6] COPY . .',
			'#6 DONE 0.3s',
			'#7 [build 5/6] RUN pnpm build',
			'#7 4.120 vite v8.3.4 building for production...',
			'#7 9.884 ✓ 1284 modules transformed.',
			'#7 11.203 ✓ built in 6.81s',
			'#7 DONE 11.6s',
			'#8 [runtime 6/6] COPY --from=build /app/build ./build',
			'#8 DONE 0.2s',
			'#9 exporting to image',
			'#9 DONE 0.9s'
		]
	},
	{
		step: 'pushing',
		ms: 3_000,
		lines: [
			'#9 pushing layers 3.1MB / 41.8MB',
			'#9 pushing layers 41.8MB / 41.8MB done',
			'#9 pushing manifest for {image} done'
		]
	},
	{
		step: 'deploying',
		ms: 4_000,
		lines: [
			'Rolling out {name} (strategy: rollingUpdate)',
			'Waiting for 1 new pod to become ready',
			'Pod {pod} is ready'
		]
	}
];

export class Store {
	state: MockState;
	private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
	private metrics: ReturnType<typeof setInterval>;

	constructor(readonly hub: EventHub) {
		this.state = seed();
		const seen = allUpdateIds();
		for (const u of this.state.users) u.seenUpdates = [...seen];
		this.resumeSeededBuilds();
		this.metrics = setInterval(() => this.pushMetrics(), 15_000);
		for (const run of this.state.jobRuns) {
			if (run.status !== 'running') continue;
			const job = this.job(run.jobId);
			this.schedule(`run:${run.id}`, 20_000, () => {
				const now = new Date().toISOString();
				run.status = 'succeeded';
				run.finishedAt = now;
				run.currentStepOrder = null;
				for (const step of run.steps) {
					step.status = 'succeeded';
					step.exitCode = 0;
					step.startedAt ??= run.startedAt;
					step.finishedAt = now;
					step.logs += 'pruned 214 expired sessions\ndone\n';
				}
				if (job) {
					this.emit('jobrun.changed', job.projectId, run.id, { jobId: job.id });
					this.emit('job.changed', job.projectId, job.id);
				}
			});
		}
		for (const db of this.state.databases) {
			if (db.status !== 'provisioning') continue;
			this.schedule(`db:${db.id}`, 45_000, () => {
				db.status = 'ready';
				this.touch(db);
				this.emit('database.changed', db.projectId, db.id);
			});
		}
	}

	dispose() {
		clearInterval(this.metrics);
		for (const key of [...this.timers.keys()]) this.cancel(key);
	}

	me(): MockUser | null {
		if (!this.state.signedIn) return null;
		return this.user(this.state.meId) ?? null;
	}

	user(id: string | null | undefined) {
		return this.state.users.find((u) => u.id === id);
	}

	org(idOrSlug: string): MockOrg | undefined {
		return this.state.orgs.find((o) => o.id === idOrSlug || o.slug === idOrSlug);
	}

	project(id: string): MockProject | undefined {
		return this.state.projects.find((p) => p.id === id || p.slug === id);
	}

	projectBySlugs(orgSlug: string, projectSlug: string) {
		const o = this.org(orgSlug);
		if (!o) return undefined;
		return this.state.projects.find((p) => p.organizationId === o.id && p.slug === projectSlug);
	}

	projectsOf(orgId: string) {
		return this.state.projects.filter((p) => p.organizationId === orgId);
	}

	deployment(id: string) {
		return this.state.deployments.find((d) => d.id === id);
	}

	deploymentsOf(projectId: string) {
		return this.state.deployments.filter((d) => d.projectId === projectId);
	}

	database(id: string) {
		return this.state.databases.find((d) => d.id === id);
	}

	databasesOf(projectId: string) {
		return this.state.databases.filter((d) => d.projectId === projectId);
	}

	job(id: string) {
		return this.state.jobs.find((j) => j.id === id);
	}

	buildsOf(deploymentId: string) {
		return this.state.builds
			.filter((b) => b.deploymentId === deploymentId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	runsOf(jobId: string) {
		return this.state.jobRuns.filter((r) => r.jobId === jobId).sort((a, b) => b.number - a.number);
	}

	orgOfProject(projectId: string) {
		const p = this.project(projectId);
		return p ? this.org(p.organizationId) : undefined;
	}

	membersOf(orgId: string) {
		return this.state.members.filter((m) => m.organizationId === orgId);
	}

	myRole(orgId: string) {
		return this.membersOf(orgId).find((m) => m.userId === this.state.meId)?.role ?? null;
	}

	myOrgs() {
		const ids = new Set(
			this.state.members.filter((m) => m.userId === this.state.meId).map((m) => m.organizationId)
		);
		return this.state.orgs.filter((o) => ids.has(o.id));
	}

	emit(type: OrgEventType, projectId: string | undefined, id?: string, payload?: unknown) {
		const o = projectId ? this.orgOfProject(projectId) : undefined;
		if (!o) return;
		this.hub.emit({ organizationId: o.id, type, id, projectId, payload });
	}

	emitOrg(orgId: string, type: OrgEventType, id?: string, payload?: unknown) {
		this.hub.emit({ organizationId: orgId, type, id, payload });
	}

	touch(d: MockDeployment | MockDatabase | MockProject | MockJob) {
		d.updatedAt = new Date().toISOString();
	}

	podName(d: MockDeployment, i: number, seed = d.podSeed) {
		return `${d.name}-${seed.slice(0, 9)}-${sha(`${seed}:${i}`).slice(0, 5)}`;
	}

	revisionsOf(d: MockDeployment) {
		d.revisions ??= [];
		if (!d.revisions.some((r) => r.seed === d.podSeed)) {
			const number = Math.max(0, ...d.revisions.map((r) => r.number)) + 1;
			d.revisions.push({ seed: d.podSeed, number, image: d.image, createdAt: d.podStartedAt });
		}
		return d.revisions;
	}

	addRevision(d: MockDeployment) {
		const list = this.revisionsOf(d);
		const seed = sha(`${d.id}:${Date.now()}:${list.length}`).slice(0, 10);
		const number = Math.max(...list.map((r) => r.number)) + 1;
		list.push({
			seed,
			number,
			image: `${d.image.split(':')[0]}:${seed.slice(0, 7)}`,
			createdAt: new Date().toISOString()
		});
		return seed;
	}

	startRollout(deploymentId: string, outcome: PodScenario, twice = false) {
		const d = this.deployment(deploymentId);
		if (!d || d.stopped) return;
		this.revisionsOf(d);
		this.cancel(`rollout:${d.id}`);
		const prev = d.rollout ? d.rollout.prev : d.podSeed;
		const first = this.addRevision(d);
		d.rollout = { prev, next: first, outcome, startedAt: Date.now() };
		d.status = 'deploying';
		this.touch(d);
		this.emit('deployment.changed', d.projectId, d.id);
		if (twice) {
			this.schedule(`rollout:${d.id}`, 1_000, () => {
				const second = this.addRevision(d);
				d.rollout = { prev, middle: first, next: second, outcome, startedAt: Date.now() };
				this.touch(d);
				this.emit('deployment.changed', d.projectId, d.id);
				this.emit('pod.changed', d.projectId, d.id, this.podPayload(d));
				this.stepRollout(d);
			});
		} else {
			this.stepRollout(d);
		}
	}

	private stepRollout(d: MockDeployment) {
		const ro = d.rollout;
		if (!ro) return;
		const healthy = ro.outcome === 'healthy';
		const tick = () => {
			if (d.rollout !== ro) return;
			const elapsed = Date.now() - ro.startedAt;
			if (ro.middle && elapsed > 2_500) ro.middle = undefined;
			if (healthy && elapsed >= d.replicas * 4_000 + 1_500) {
				d.podSeed = ro.next;
				d.podStartedAt = new Date().toISOString();
				d.rollout = null;
				d.status = d.crash ? 'crashing' : 'running';
			} else if (!healthy && elapsed >= 45_000) {
				ro.failed = true;
			} else {
				this.schedule(`rollout:${d.id}`, 2_000, tick);
			}
			this.touch(d);
			this.emit('deployment.changed', d.projectId, d.id);
			this.emit('pod.changed', d.projectId, d.id, this.podPayload(d));
		};
		this.schedule(`rollout:${d.id}`, 2_000, tick);
	}

	cancelRollout(deploymentId: string) {
		const d = this.deployment(deploymentId);
		if (!d?.rollout) return;
		this.cancel(`rollout:${d.id}`);
		d.rollout = null;
		d.status = d.crash ? 'crashing' : 'running';
		this.touch(d);
		this.emit('deployment.changed', d.projectId, d.id);
	}

	podsFor: (d: MockDeployment) => Record<string, unknown>[] = () => [];
	private seenPods = new Map<string, Set<string>>();

	notePods(deploymentId: string, names: string[]) {
		const seen = this.seenPods.get(deploymentId) ?? new Set<string>();
		for (const n of names) seen.add(n);
		this.seenPods.set(deploymentId, seen);
	}

	podPayload(d: MockDeployment) {
		const pods = this.podsFor(d);
		const names = new Set(pods.map((p) => String(p.name)));
		const gone = [...(this.seenPods.get(d.id) ?? [])]
			.filter((n) => !names.has(n))
			.map((name) => ({ name, deleted: true }));
		this.seenPods.set(d.id, names);
		const batch = [...pods, ...gone];
		return { ...batch[batch.length - 1], pods: batch };
	}

	private pushMetrics() {
		for (const org of this.state.orgs) {
			if (!this.hub.watching(org.id)) continue;
			const pids = new Set(this.projectsOf(org.id).map((p) => p.id));
			for (const d of this.state.deployments) {
				if (!pids.has(d.projectId) || d.stopped || d.replicas === 0) continue;
				const wobble = () => 0.9 + Math.random() * 0.2;
				const pods: Record<string, { cpuUsage: number; memoryUsage: number }> = {};
				let cpu = 0;
				let mem = 0;
				for (let i = 0; i < d.replicas; i++) {
					const running = podShape(d, this.podName(d, i), scenarioOf(d, i)).running;
					const c = running ? Math.round((d.cpuUsageMilli / d.replicas) * wobble()) : 0;
					const m = running ? Math.round((d.memoryUsageBytes / d.replicas) * wobble()) : 0;
					pods[this.podName(d, i)] = { cpuUsage: c, memoryUsage: m };
					cpu += c;
					mem += m;
				}
				this.hub.emit({
					organizationId: org.id,
					type: 'deployment.metrics',
					id: d.id,
					projectId: d.projectId,
					payload: { totalCpuUsage: cpu, totalMemoryUsage: mem, meteredPods: d.replicas, pods }
				});
			}
		}
	}

	private schedule(key: string, ms: number, fn: () => void) {
		const t = setTimeout(fn, ms);
		const list = this.timers.get(key) ?? [];
		list.push(t);
		this.timers.set(key, list);
	}

	private cancel(key: string) {
		for (const t of this.timers.get(key) ?? []) clearTimeout(t);
		this.timers.delete(key);
	}

	private fill(line: string, d: MockDeployment, b: MockBuild) {
		return line
			.replaceAll('{repo}', d.githubRepo ?? 'hackclub/app')
			.replaceAll('{branch}', b.branch ?? 'main')
			.replaceAll('{short}', (b.commitSha ?? '').slice(0, 7))
			.replaceAll('{message}', b.commitMessage ?? '')
			.replaceAll('{image}', b.image)
			.replaceAll('{name}', d.name)
			.replaceAll('{pod}', this.podName(d, 0));
	}

	private appendLog(d: MockDeployment, b: MockBuild, lines: string[]) {
		const text = lines.map((l) => `${this.fill(l, d, b)}\n`).join('');
		d.buildLogs += text;
		b.logs += text;
	}

	redeploy(
		deploymentId: string,
		opts: { trigger?: MockBuild['triggerType']; rebuild?: boolean; failure?: BuildFailureKind } = {}
	) {
		const d = this.deployment(deploymentId);
		if (!d) return null;
		this.cancel(`build:${d.id}`);
		const me = this.me() ?? this.state.users[0];
		const prev = this.buildsOf(d.id)[0];
		for (const b of this.state.builds) {
			if (b.deploymentId === d.id && b.status === 'building') b.status = 'canceled';
		}
		const now = new Date().toISOString();
		const commitSha = d.githubRepo
			? opts.rebuild === false && prev?.commitSha
				? prev.commitSha
				: sha(`${d.id}:${Date.now()}`)
			: null;
		const build: MockBuild = {
			id: freshId(),
			deploymentId: d.id,
			image: d.githubRepo
				? `registry.orchard.my/${d.name}:${(commitSha ?? '').slice(0, 7)}`
				: d.image,
			branch: d.githubBranch,
			commitSha,
			commitMessage: d.githubRepo ? (prev?.commitMessage ?? 'Redeploy') : null,
			commitAuthorName: `${me.firstName} ${me.lastName}`,
			commitAuthorUsername: me.username,
			triggerType: opts.trigger ?? 'manual',
			triggeredById: me.id,
			status: 'building',
			isActive: false,
			buildStartedAt: now,
			buildCompletedAt: null,
			createdAt: now,
			logs: ''
		};
		this.state.builds.push(build);
		d.buildStatus = 'building';
		d.buildError = null;
		d.buildLogs = '';
		d.buildStepTimestamps = {};
		const phases = d.githubRepo
			? PHASES
			: PHASES.filter((p) => p.step === 'queued' || p.step === 'deploying');
		let at = 0;
		const failure = opts.failure ? BUILD_FAILURES[opts.failure] : null;
		for (const phase of phases) {
			if (failure && phase.step === failure.at) {
				const failing = { ...phase, ms: 3_000, lines: [...failure.lines] };
				this.schedule(`build:${d.id}`, at, () => this.enterPhase(d, build, failing));
				at += failing.ms;
				this.schedule(`build:${d.id}`, at, () => this.failBuild(d, build, failure.error));
				break;
			}
			this.schedule(`build:${d.id}`, at, () => this.enterPhase(d, build, phase));
			at += phase.ms;
		}
		if (!failure) this.schedule(`build:${d.id}`, at, () => this.finishBuild(d, build));
		this.touch(d);
		this.emit('build.changed', d.projectId, d.id);
		return build;
	}

	private enterPhase(d: MockDeployment, b: MockBuild, phase: (typeof PHASES)[number]) {
		d.buildStep = phase.step;
		d.buildStepTimestamps = { ...d.buildStepTimestamps, [phase.step]: Date.now() };
		if (phase.step === 'deploying' && !d.stopped) d.status = 'deploying';
		const per = Math.max(250, Math.floor(phase.ms / phase.lines.length));
		phase.lines.forEach((line, i) => {
			this.schedule(`build:${d.id}`, i * per, () => {
				this.appendLog(d, b, [line]);
				if (i > 0) this.emit('build.changed', d.projectId, d.id, { log: true });
			});
		});
		this.touch(d);
		this.emit('build.changed', d.projectId, d.id, { step: phase.step });
		if (phase.step === 'deploying') this.emit('deployment.changed', d.projectId, d.id);
	}

	private finishBuild(d: MockDeployment, b: MockBuild) {
		this.timers.delete(`build:${d.id}`);
		for (const other of this.state.builds) if (other.deploymentId === d.id) other.isActive = false;
		b.status = 'succeeded';
		b.isActive = true;
		b.buildCompletedAt = new Date().toISOString();
		d.buildStatus = 'succeeded';
		d.buildStep = 'complete';
		d.buildStepTimestamps = { ...d.buildStepTimestamps, complete: Date.now() };
		d.image = b.image;
		d.crash = null;
		d.restarts = 0;
		d.stopped = false;
		if (d.replicas === 0) d.replicas = 1;
		d.status = 'running';
		this.revisionsOf(d);
		d.podSeed = this.addRevision(d);
		d.podStartedAt = new Date().toISOString();
		this.appendLog(d, b, ['Deployment is live']);
		this.touch(d);
		this.emit('build.changed', d.projectId, d.id, { step: 'complete' });
		this.emit('deployment.changed', d.projectId, d.id);
		this.emit('pod.changed', d.projectId, d.id, this.podPayload(d));
	}

	private failBuild(d: MockDeployment, b: MockBuild, error: string) {
		this.timers.delete(`build:${d.id}`);
		b.status = 'failed';
		b.buildCompletedAt = new Date().toISOString();
		d.buildStatus = 'failed';
		d.buildError = this.fill(error, d, b);
		if (d.status === 'deploying') d.status = d.crash ? 'crashing' : 'running';
		this.touch(d);
		this.emit('build.changed', d.projectId, d.id);
		this.emit('deployment.changed', d.projectId, d.id);
	}

	private resumeSeededBuilds() {
		for (const d of this.state.deployments) {
			if (d.buildStatus !== 'building') continue;
			const b = this.state.builds.find((x) => x.deploymentId === d.id && x.status === 'building');
			if (!b) continue;
			this.appendLog(d, b, [
				...PHASES[0].lines,
				...PHASES[1].lines,
				...PHASES[2].lines.slice(0, 6)
			]);
			this.schedule(`build:${d.id}`, 6_000, () => this.enterPhase(d, b, PHASES[3]));
			this.schedule(`build:${d.id}`, 9_000, () => this.enterPhase(d, b, PHASES[4]));
			this.schedule(`build:${d.id}`, 13_000, () => this.finishBuild(d, b));
		}
	}

	cancelBuild(deploymentId: string) {
		const d = this.deployment(deploymentId);
		if (!d) return;
		this.cancel(`build:${d.id}`);
		const b = this.state.builds.find((x) => x.deploymentId === d.id && x.status === 'building');
		if (b) {
			b.status = 'canceled';
			b.buildCompletedAt = new Date().toISOString();
		}
		d.buildStatus = 'canceled';
		if (d.status === 'deploying') d.status = d.crash ? 'crashing' : 'running';
		this.touch(d);
		this.emit('build.changed', d.projectId, d.id);
	}

	restart(deploymentId: string) {
		const d = this.deployment(deploymentId);
		if (!d) return;
		d.status = 'restarting';
		this.touch(d);
		this.emit('deployment.changed', d.projectId, d.id);
		this.schedule(`restart:${d.id}`, 4_000, () => {
			d.podSeed = sha(`${d.id}:${Date.now()}`).slice(0, 10);
			d.podStartedAt = new Date().toISOString();
			d.status = d.crash ? 'crashing' : 'running';
			d.restarts = d.crash ? 1 : 0;
			this.touch(d);
			this.emit('deployment.changed', d.projectId, d.id);
			this.emit('pod.changed', d.projectId, d.id, this.podPayload(d));
		});
	}

	scale(deploymentId: string, replicas: number) {
		const d = this.deployment(deploymentId);
		if (!d) return;
		d.replicas = Math.max(0, Math.round(replicas));
		d.stopped = d.replicas === 0;
		d.status = d.stopped ? 'stopped' : 'scaling';
		this.touch(d);
		this.emit('deployment.changed', d.projectId, d.id);
		this.schedule(`scale:${d.id}`, 2_500, () => {
			d.status = d.stopped ? 'stopped' : d.crash ? 'crashing' : 'running';
			this.touch(d);
			this.emit('deployment.changed', d.projectId, d.id);
			this.emit('pod.changed', d.projectId, d.id, this.podPayload(d));
		});
	}

	setStopped(deploymentId: string, stopped: boolean) {
		const d = this.deployment(deploymentId);
		if (!d) return;
		if (stopped) {
			d.stopped = true;
			d.status = 'stopped';
			this.touch(d);
			this.emit('deployment.changed', d.projectId, d.id);
		} else {
			if (d.replicas === 0) d.replicas = 1;
			this.scale(d.id, d.replicas);
		}
	}

	runJob(jobId: string): MockJobRun | null {
		const job = this.job(jobId);
		if (!job) return null;
		const last = this.runsOf(job.id)[0];
		const now = new Date().toISOString();
		const run: MockJobRun = {
			id: freshId(),
			jobId: job.id,
			number: (last?.number ?? 0) + 1,
			status: 'running',
			trigger: 'manual',
			startedAt: now,
			finishedAt: null,
			createdAt: now,
			currentStepOrder: 0,
			errorMessage: null,
			scheduledFor: null,
			triggeredById: this.state.meId,
			steps: job.steps.map((s, i) => ({
				id: freshId(),
				stepOrder: s.stepOrder,
				name: s.name,
				type: s.type,
				resolvedImage: s.image ?? 'registry.orchard.my/app:latest',
				command: s.command,
				status: i === 0 ? 'running' : 'pending',
				exitCode: null,
				reason: null,
				logsTruncated: false,
				startedAt: i === 0 ? now : null,
				finishedAt: null,
				logs: i === 0 ? `starting ${s.name}\n` : ''
			}))
		};
		this.state.jobRuns.push(run);
		const emit = () => {
			this.emit('jobrun.changed', job.projectId, run.id, { jobId: job.id });
			this.emit('job.changed', job.projectId, job.id);
		};
		emit();
		run.steps.forEach((step, i) => {
			this.schedule(`run:${run.id}`, (i + 1) * 3_000, () => {
				step.status = 'succeeded';
				step.exitCode = 0;
				step.finishedAt = new Date().toISOString();
				step.logs += `processed ${400 + i * 37} records\ndone\n`;
				const next = run.steps[i + 1];
				if (next) {
					next.status = 'running';
					next.startedAt = new Date().toISOString();
					next.logs = `starting ${next.name}\n`;
					run.currentStepOrder = next.stepOrder;
				} else {
					run.status = 'succeeded';
					run.finishedAt = new Date().toISOString();
					run.currentStepOrder = null;
				}
				emit();
			});
		});
		return run;
	}

	cancelRun(runId: string) {
		const run = this.state.jobRuns.find((r) => r.id === runId);
		if (!run || run.finishedAt) return run;
		this.cancel(`run:${run.id}`);
		run.status = 'canceled';
		run.finishedAt = new Date().toISOString();
		for (const s of run.steps) {
			if (s.status === 'running' || s.status === 'pending') {
				s.status = s.status === 'running' ? 'canceled' : 'skipped';
				s.finishedAt = run.finishedAt;
			}
		}
		const job = this.job(run.jobId);
		if (job) this.emit('jobrun.changed', job.projectId, run.id, { jobId: job.id });
		return run;
	}

	removeDeployment(id: string) {
		const d = this.deployment(id);
		if (!d) return;
		this.cancel(`build:${d.id}`);
		this.state.deployments = this.state.deployments.filter((x) => x.id !== id);
		this.state.builds = this.state.builds.filter((b) => b.deploymentId !== id);
		this.emit('deployment.changed', d.projectId, d.id, { deleted: true });
	}

	removeDatabase(id: string) {
		const db = this.database(id);
		if (!db) return;
		this.state.databases = this.state.databases.filter((x) => x.id !== id);
		this.emit('database.changed', db.projectId, db.id, { deleted: true });
	}

	provisionDatabase(db: MockDatabase) {
		this.state.databases.push(db);
		this.emit('database.changed', db.projectId, db.id);
		this.schedule(`db:${db.id}`, 6_000, () => {
			db.status = 'ready';
			this.touch(db);
			this.emit('database.changed', db.projectId, db.id);
		});
	}

	newDeploymentId(projectId: string, name: string) {
		const taken = new Set(this.state.deployments.map((d) => d.id));
		const id = uid(`dep:${projectId}:${name}`);
		return taken.has(id) ? freshId() : id;
	}

	createdAgo(minutes: number) {
		return ago(minutes);
	}
}

export function createStore(hub: EventHub) {
	return new Store(hub);
}
