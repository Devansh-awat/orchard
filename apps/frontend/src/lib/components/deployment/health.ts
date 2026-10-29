export type HealthPod = {
	name: string;
	status?: string | null;
	revision?: string | null;
	restartCount?: number | null;
	containers?: {
		name: string;
		ready?: boolean;
		lastTermination?: { reason?: string | null; exitCode?: number | null } | null;
	}[];
};

export type HealthWarning = { podName?: string; message: string };

export type RolloutRevision = {
	hash: string;
	number: number;
	image?: string | null;
	createdAt?: string | null;
	replicas: number;
	ready: number;
};

export type Rollout = {
	currentRevision: string | null;
	revisions: RolloutRevision[];
	desired: number;
	updated: number;
	ready: number;
	available: number;
	state: 'stable' | 'progressing' | 'failed';
	reason: string | null;
};

export type HealthInput = {
	pods: HealthPod[];
	warnings?: HealthWarning[];
	rollout?: Rollout | null;
	replicas: number;
	stopped?: boolean;
	buildStatus?: string | null;
	buildError?: string | null;
	strategy?: 'rollingUpdate' | 'recreate' | 'blueGreen' | null;
};

export type PodProblem =
	| 'crash-loop'
	| 'out-of-memory'
	| 'image-pull'
	| 'missing-config'
	| 'unschedulable'
	| 'not-ready'
	| 'exited'
	| 'evicted'
	| 'lost';

export type PodVersion = 'new' | 'old' | 'replaced';

export type ClassifiedPod = {
	name: string;
	state: 'running' | 'starting' | 'waiting' | 'failing' | 'stopping' | 'unknown';
	problem: PodProblem | null;
	version: PodVersion | null;
	revision: number | null;
};

export type AppState = 'healthy' | 'degraded' | 'down' | 'starting' | 'stopped' | 'unknown';
export type DeployState = 'deploying' | 'stuck' | 'failed';
export type BuildState = 'building' | 'failed' | null;

export type Problem = {
	id: string;
	scope: 'app' | 'deploy' | 'build';
	tone: 'error' | 'warning';
	title: string;
	hint: string;
	problem?: PodProblem;
	pods?: string[];
};

export type Health = {
	app: AppState;
	deploy: DeployState | null;
	build: BuildState;
	serving: number;
	desired: number;
	current: RolloutRevision | null;
	previous: RolloutRevision | null;
	progress: number | null;
	pods: ClassifiedPod[];
	problems: Problem[];
};

const PROBLEM_COPY: Record<PodProblem, { title: string; deploy: string; hint: string }> = {
	'crash-loop': {
		title: 'keeps crashing',
		deploy: 'The new version crashes on start',
		hint: 'Check the logs from before the crash.'
	},
	'out-of-memory': {
		title: 'runs out of memory',
		deploy: 'The new version runs out of memory',
		hint: 'Raise the memory limit or fix the leak.'
	},
	'image-pull': {
		title: "can't pull its image",
		deploy: "Can't pull the new image",
		hint: 'The tag may be wrong or the registry needs a login.'
	},
	'missing-config': {
		title: 'is missing a secret',
		deploy: 'The new version is missing a secret',
		hint: 'Add the missing variable or secret.'
	},
	unschedulable: {
		title: 'has no room to start',
		deploy: 'No room to start the new version',
		hint: 'The cluster is full. Lower the requests or wait for capacity.'
	},
	'not-ready': {
		title: 'is failing its health check',
		deploy: "The new version isn't passing its health check",
		hint: 'It is running but never reports ready.'
	},
	exited: {
		title: 'exits right after starting',
		deploy: 'The new version exits right after starting',
		hint: 'Check the start command.'
	},
	evicted: {
		title: 'was evicted',
		deploy: 'The new version was evicted',
		hint: 'The node ran low on resources.'
	},
	lost: {
		title: 'is on a node we lost contact with',
		deploy: 'Lost contact with the node running the new version',
		hint: 'It may still be running.'
	}
};

const FATAL: ReadonlySet<PodProblem> = new Set([
	'crash-loop',
	'out-of-memory',
	'image-pull',
	'missing-config',
	'exited'
]);

function problemOf(pod: HealthPod, warnings: HealthWarning[]): PodProblem | null {
	const status = (pod.status ?? '').toLowerCase();
	if (status === 'ready' || status === 'terminating' || status === 'succeeded') return null;
	if (status === 'unknown') return 'lost';
	const lines = warnings.filter((w) => w.podName === pod.name).map((w) => w.message);
	const text = lines.join('\n');
	if (/evicted/i.test(text) || (status === 'failed' && /evict/i.test(text))) return 'evicted';
	if (
		/imagepullbackoff|errimagepull|pulling image|failed to pull image|invalidimagename/i.test(text)
	)
		return 'image-pull';
	if (/(secret|configmap) "[^"]+" not found|createcontainerconfigerror/i.test(text))
		return 'missing-config';
	if (/failedscheduling|nodes are available|insufficient (cpu|memory)/i.test(text))
		return 'unschedulable';
	const term = pod.containers?.find((c) => c.lastTermination?.reason)?.lastTermination;
	if (status === 'crashing' || status === 'failed') {
		if (term?.reason === 'OOMKilled' || /oomkilled/i.test(text)) return 'out-of-memory';
		if (term?.reason === 'Completed' || term?.exitCode === 0) return 'exited';
		return 'crash-loop';
	}
	if (status === 'pending' && lines.length) return 'unschedulable';
	if (status === 'starting' && /readiness probe failed/i.test(text)) return 'not-ready';
	return null;
}

function stateOf(pod: HealthPod, problem: PodProblem | null): ClassifiedPod['state'] {
	const status = (pod.status ?? '').toLowerCase();
	if (status === 'terminating') return 'stopping';
	if (status === 'unknown') return 'unknown';
	if (status === 'ready') return 'running';
	if (problem && problem !== 'not-ready' && problem !== 'unschedulable') return 'failing';
	if (problem) return 'waiting';
	return 'starting';
}

function plural(n: number, one: string, many = `${one}s`) {
	return `${n} ${n === 1 ? one : many}`;
}

export function computeHealth(input: HealthInput): Health {
	const warnings = input.warnings ?? [];
	const rollout = input.rollout ?? null;
	const revisions = rollout?.revisions ?? [];
	const current = revisions.find((r) => r.hash === rollout?.currentRevision) ?? null;
	const others = revisions.filter((r) => r !== current);
	const previous =
		others.filter((r) => r.ready > 0).sort((a, b) => b.number - a.number)[0] ??
		others.sort((a, b) => b.number - a.number)[0] ??
		null;
	const rolling =
		!!rollout &&
		rollout.state !== 'stable' &&
		!!current &&
		(others.length > 0 || rollout.state === 'failed');
	const numberOf = (hash?: string | null) => revisions.find((r) => r.hash === hash)?.number ?? null;

	const pods: ClassifiedPod[] = input.pods.map((pod) => {
		const problem = problemOf(pod, warnings);
		let version: PodVersion | null = null;
		if (rolling && pod.revision) {
			version =
				pod.revision === current?.hash
					? 'new'
					: pod.revision === previous?.hash
						? 'old'
						: 'replaced';
		}
		return {
			name: pod.name,
			state: stateOf(pod, problem),
			problem,
			version,
			revision: numberOf(pod.revision)
		};
	});

	const live = pods.filter((p) => p.state !== 'stopping');
	const serving = live.filter((p) => p.state === 'running').length;
	const desired = input.stopped ? 0 : input.replicas;
	const fresh = rolling ? live.filter((p) => p.version === 'new') : [];
	const settled = rolling ? live.filter((p) => p.version !== 'new') : live;

	const build: BuildState =
		input.buildStatus === 'building' ||
		input.buildStatus === 'queued' ||
		input.buildStatus === 'pending'
			? 'building'
			: input.buildStatus === 'failed'
				? 'failed'
				: null;

	let deploy: DeployState | null = null;
	const freshFatal = fresh.filter((p) => p.problem && FATAL.has(p.problem));
	const freshSlow = fresh.filter((p) => p.problem === 'unschedulable' || p.problem === 'not-ready');
	if (rolling) {
		if (rollout?.state === 'failed' || freshFatal.length) deploy = 'failed';
		else if (freshSlow.length) deploy = 'stuck';
		else deploy = 'deploying';
	}

	let app: AppState;
	const settledBad = settled.filter((p) => p.state === 'failing' || p.state === 'waiting');
	const anyStarting = live.some((p) => p.state === 'starting');
	if (desired === 0) app = 'stopped';
	else if (live.length && live.every((p) => p.state === 'unknown')) app = 'unknown';
	else if (serving === 0 && (anyStarting || (deploy === 'deploying' && !settledBad.length)))
		app = 'starting';
	else if (serving === 0 && live.length === 0) app = 'starting';
	else if (serving === 0) app = 'down';
	else if (
		settledBad.length &&
		!(deploy === 'deploying' && fresh.some((p) => p.state === 'running'))
	)
		app = 'degraded';
	else app = 'healthy';

	const problems: Problem[] = [];
	const versionLabel = (r: RolloutRevision | null) => (r ? `v${r.number}` : 'the previous version');

	if (build === 'failed') {
		problems.push({
			id: 'build',
			scope: 'build',
			tone: 'error',
			title: 'Build failed',
			hint:
				serving > 0
					? `Nothing was deployed. Still serving ${versionLabel(current ?? previous)}.`
					: 'Nothing was deployed.'
		});
	}

	if (deploy === 'failed' || deploy === 'stuck') {
		const lead = (deploy === 'failed' ? freshFatal : freshSlow)[0];
		const copy = lead?.problem ? PROBLEM_COPY[lead.problem] : null;
		const title =
			copy?.deploy ??
			(rollout?.reason === 'ProgressDeadlineExceeded'
				? 'The new version never became ready'
				: 'The deploy failed');
		const still =
			serving > 0 ? `Still serving ${versionLabel(previous)}.` : 'Nothing is serving traffic.';
		problems.push({
			id: 'deploy',
			scope: 'deploy',
			tone: deploy === 'failed' || serving === 0 ? 'error' : 'warning',
			title:
				build === null && deploy === 'failed'
					? `Deploy failed: ${title.charAt(0).toLowerCase()}${title.slice(1)}`
					: title,
			hint: `The build succeeded. ${still} ${copy?.hint ?? ''}`.trim(),
			problem: lead?.problem ?? undefined,
			pods: (deploy === 'failed' ? freshFatal : freshSlow).map((p) => p.name)
		});
	}

	if (app === 'down' || app === 'degraded') {
		const bad = settledBad.length ? settledBad : live.filter((p) => p.problem);
		const counts = new Map<PodProblem, string[]>();
		for (const p of bad) {
			if (!p.problem) continue;
			counts.set(p.problem, [...(counts.get(p.problem) ?? []), p.name]);
		}
		const [lead, names] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [
			null,
			[]
		];
		const copy = lead ? PROBLEM_COPY[lead] : null;
		if (app === 'down') {
			problems.unshift({
				id: 'app',
				scope: 'app',
				tone: 'error',
				title:
					deploy === 'failed'
						? 'Your app is down, and the new version fails too'
						: copy
							? `Your app is down: it ${copy.title}`
							: 'Your app is down',
				hint: copy?.hint ?? 'No pod is serving traffic.',
				problem: lead ?? undefined,
				pods: names
			});
		} else {
			problems.push({
				id: 'app',
				scope: 'app',
				tone: 'warning',
				title: copy
					? `${plural(names.length, 'pod')} of ${live.length} ${copy.title}`
					: `${plural(bad.length, 'pod')} unhealthy`,
				hint: `${plural(serving, 'pod')} still serving. ${copy?.hint ?? ''}`.trim(),
				problem: lead ?? undefined,
				pods: names
			});
		}
	}

	if (app === 'unknown') {
		problems.push({
			id: 'app',
			scope: 'app',
			tone: 'warning',
			title: 'Lost contact with the node running this app',
			hint: 'It may still be running.'
		});
	}

	const progress =
		rolling && desired > 0
			? Math.min(
					1,
					live.filter((p) => p.version === 'new' && p.state === 'running').length / desired
				)
			: null;

	return {
		app,
		deploy,
		build,
		serving,
		desired,
		current,
		previous: rolling ? previous : null,
		progress,
		pods,
		problems
	};
}
