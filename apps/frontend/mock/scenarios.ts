import type { MockDeployment } from './types.ts';

export const POD_SCENARIOS = [
	'healthy',
	'crash-loop',
	'out-of-memory',
	'image-pull',
	'missing-secret',
	'unschedulable',
	'not-ready',
	'terminating',
	'evicted',
	'liveness',
	'sidecar-crash',
	'init-crash',
	'node-lost'
] as const;

export type PodScenario = (typeof POD_SCENARIOS)[number];

type Termination = { reason: string; exitCode: number } | null;

export type PodShape = {
	status: string;
	running: boolean;
	scheduled: boolean;
	restarts: number;
	termination: Termination;
	warnings: string[];
	events: { type: string; reason: string; message: string; count: number }[];
};

export function scenarioOf(d: MockDeployment, index: number): PodScenario {
	const set = d.podScenarios?.[index];
	if (set) return set;
	if (d.crash) return d.crash.reason === 'OOMKilled' ? 'out-of-memory' : 'crash-loop';
	return 'healthy';
}

export function podShape(d: MockDeployment, pod: string, scenario: PodScenario): PodShape {
	const c = d.name;
	const backoff = `${c}: back-off 2m40s restarting failed container=${c} pod=${pod}`;
	switch (scenario) {
		case 'crash-loop': {
			const exitCode = d.crash && d.crash.reason !== 'OOMKilled' ? d.crash.exitCode : 1;
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: Math.max(d.restarts, 6),
				termination: { reason: 'Error', exitCode },
				warnings: [backoff, `${c} has restarted ${Math.max(d.restarts, 6)} time(s)`],
				events: [
					{
						type: 'Warning',
						reason: 'BackOff',
						message: `Back-off restarting failed container ${c} in pod ${pod}`,
						count: 31
					}
				]
			};
		}
		case 'liveness':
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: Math.max(d.restarts, 4),
				termination: { reason: 'Error', exitCode: 137 },
				warnings: ['Unhealthy: Liveness probe failed: HTTP probe failed with statuscode: 500'],
				events: [
					{
						type: 'Warning',
						reason: 'Unhealthy',
						message: 'Liveness probe failed: HTTP probe failed with statuscode: 500',
						count: 12
					}
				]
			};
		case 'sidecar-crash':
			return {
				status: 'crashing',
				running: true,
				scheduled: true,
				restarts: d.restarts,
				termination: null,
				warnings: [`proxy: back-off 1m20s restarting failed container=proxy pod=${pod}`],
				events: []
			};
		case 'init-crash':
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: 0,
				termination: null,
				warnings: [`migrate: back-off 1m20s restarting failed container=migrate pod=${pod}`],
				events: []
			};
		case 'node-lost':
			return {
				status: 'unknown',
				running: true,
				scheduled: true,
				restarts: d.restarts,
				termination: null,
				warnings: [],
				events: []
			};
		case 'out-of-memory':
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: Math.max(d.restarts, 14),
				termination: { reason: 'OOMKilled', exitCode: 137 },
				warnings: [backoff, `${c}: last terminated with OOMKilled (exit code 137)`],
				events: [
					{
						type: 'Warning',
						reason: 'BackOff',
						message: `Back-off restarting failed container ${c} in pod ${pod}`,
						count: 58
					}
				]
			};
		case 'image-pull':
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: 0,
				termination: null,
				warnings: [`${c}: Back-off pulling image "${d.image}"`],
				events: [
					{
						type: 'Warning',
						reason: 'Failed',
						message: `Failed to pull image "${d.image}": rpc error: code = NotFound desc = manifest unknown`,
						count: 7
					},
					{
						type: 'Warning',
						reason: 'BackOff',
						message: `Back-off pulling image "${d.image}"`,
						count: 22
					}
				]
			};
		case 'missing-secret':
			return {
				status: 'crashing',
				running: false,
				scheduled: true,
				restarts: 0,
				termination: null,
				warnings: [`${c}: secret "${c}-env" not found`],
				events: [
					{
						type: 'Warning',
						reason: 'Failed',
						message: `Error: secret "${c}-env" not found`,
						count: 12
					}
				]
			};
		case 'unschedulable':
			return {
				status: 'pending',
				running: false,
				scheduled: false,
				restarts: 0,
				termination: null,
				warnings: [
					'FailedScheduling: 0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.'
				],
				events: [
					{
						type: 'Warning',
						reason: 'FailedScheduling',
						message:
							'0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.',
						count: 9
					}
				]
			};
		case 'not-ready':
			return {
				status: 'starting',
				running: true,
				scheduled: true,
				restarts: 0,
				termination: null,
				warnings: ['Unhealthy: Readiness probe failed: HTTP probe failed with statuscode: 503'],
				events: [
					{
						type: 'Warning',
						reason: 'Unhealthy',
						message: 'Readiness probe failed: HTTP probe failed with statuscode: 503',
						count: 18
					}
				]
			};
		case 'terminating':
			return {
				status: 'terminating',
				running: true,
				scheduled: true,
				restarts: d.restarts,
				termination: null,
				warnings: [],
				events: [
					{
						type: 'Normal',
						reason: 'Killing',
						message: `Stopping container ${c}`,
						count: 1
					}
				]
			};
		case 'evicted':
			return {
				status: 'failed',
				running: false,
				scheduled: true,
				restarts: 0,
				termination: null,
				warnings: [
					'Evicted: The node was low on resource: memory. Threshold quantity: 100Mi, available: 82Mi.'
				],
				events: [
					{
						type: 'Warning',
						reason: 'Evicted',
						message:
							'The node was low on resource: memory. Threshold quantity: 100Mi, available: 82Mi.',
						count: 1
					}
				]
			};
		default:
			return {
				status: d.status === 'restarting' || d.status === 'scaling' ? 'starting' : 'ready',
				running: true,
				scheduled: true,
				restarts: d.restarts,
				termination: null,
				warnings: [],
				events: [
					{
						type: 'Normal',
						reason: 'Started',
						message: `Started container ${c}`,
						count: 1
					}
				]
			};
	}
}

export function statusFromPods(d: MockDeployment, statuses: string[]) {
	if (!statuses.length) return d.status;
	const bad = statuses.filter((s) => s === 'crashing' || s === 'failed').length;
	const ready = statuses.filter((s) => s === 'ready').length;
	if (bad && !ready) return 'crashing';
	if (bad || ready < statuses.length) return 'unhealthy';
	return 'running';
}

export type FactsInput = {
	since: string;
	startedAt: string;
	image: string;
	booting?: boolean;
};

export function podFacts(d: MockDeployment, scenario: PodScenario, shape: PodShape, o: FactsInput) {
	const iso = (t: number) => new Date(t).toISOString();
	const recent = iso(Date.now() - 20_000);
	const term = shape.termination ? { ...shape.termination, finishedAt: recent } : null;
	const main = (over: Record<string, unknown> = {}) => ({
		name: d.name,
		init: false,
		image: o.image,
		ready: true,
		restartCount: shape.restarts,
		state: 'running',
		reason: null,
		message: null,
		startedAt: o.startedAt,
		lastTermination: term,
		...over
	});
	const base = {
		phase: 'Running',
		reason: null as string | null,
		slot: null,
		disruption: null,
		probes: { liveness: false, readiness: true, startup: false },
		deletingAt: null as string | null,
		graceSeconds: 30,
		scheduled: true,
		unschedulableSince: null as string | null,
		schedulingMessage: null as string | null,
		readySince: o.startedAt as string | null,
		notReadySince: null as string | null,
		createdAt: o.startedAt
	};
	const unready = { readySince: null, notReadySince: o.since };
	const backoff = { ready: false, state: 'waiting', reason: 'CrashLoopBackOff', startedAt: null };
	const crashed = (name: string, init: boolean) => ({
		...main(backoff),
		name,
		init,
		restartCount: 5,
		lastTermination: { reason: 'Error', exitCode: 1, finishedAt: recent }
	});
	const pending = (reason: string, message: string) => ({
		...base,
		...unready,
		phase: 'Pending',
		createdAt: o.since,
		containers: [
			main({
				ready: false,
				state: 'waiting',
				reason,
				message,
				startedAt: null,
				lastTermination: null
			})
		]
	});
	if (o.booting || (scenario === 'healthy' && shape.status === 'starting')) {
		return {
			...base,
			...unready,
			createdAt: o.since,
			containers: [main({ ready: false, startedAt: o.since })]
		};
	}
	switch (scenario) {
		case 'crash-loop':
		case 'out-of-memory':
			return { ...base, ...unready, containers: [main(backoff)] };
		case 'liveness':
			return {
				...base,
				...unready,
				probes: { ...base.probes, liveness: true },
				containers: [main(backoff)]
			};
		case 'image-pull':
			return pending('ImagePullBackOff', `Back-off pulling image "${o.image}": manifest unknown`);
		case 'missing-secret':
			return pending('CreateContainerConfigError', `secret "${d.name}-env" not found`);
		case 'unschedulable':
			return {
				...base,
				...unready,
				phase: 'Pending',
				scheduled: false,
				createdAt: o.since,
				unschedulableSince: o.since,
				schedulingMessage: '0/3 nodes are available: 3 Insufficient memory.',
				containers: [
					main({ ready: false, state: 'unknown', startedAt: null, lastTermination: null })
				]
			};
		case 'not-ready':
			return { ...base, ...unready, containers: [main({ ready: false })] };
		case 'terminating':
			return { ...base, deletingAt: iso(Date.parse(o.since) + 30_000), containers: [main()] };
		case 'evicted':
			return {
				...base,
				...unready,
				phase: 'Failed',
				reason: 'Evicted',
				containers: [main({ ready: false, state: 'terminated', reason: 'Error' })]
			};
		case 'sidecar-crash':
			return { ...base, ...unready, containers: [main(), crashed('proxy', false)] };
		case 'init-crash':
			return {
				...base,
				...unready,
				phase: 'Pending',
				containers: [
					crashed('migrate', true),
					main({
						ready: false,
						state: 'waiting',
						reason: 'PodInitializing',
						startedAt: null,
						lastTermination: null
					})
				]
			};
		case 'node-lost':
			return { ...base, ...unready, containers: [main()] };
		default:
			return { ...base, containers: [main()] };
	}
}
