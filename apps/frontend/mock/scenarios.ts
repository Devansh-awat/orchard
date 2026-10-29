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
	'evicted'
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
