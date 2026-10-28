import { apiFetch } from '$lib/stores';

const WINDOW_MS = 30 * 60_000;
const STEP_MS = 60_000;
const MAX_POINTS = 60;
const MIB = 1024 * 1024;

type Point = { x: number; y: number };

export class UsageHistory {
	cpu = $state<number[]>([]);
	mem = $state<number[]>([]);
	#loadedFor = '';

	async load(deploymentId: string) {
		if (!deploymentId || this.#loadedFor === deploymentId) return;
		this.#loadedFor = deploymentId;
		const end = Date.now();
		const start = end - WINDOW_MS;
		try {
			const res = await apiFetch(
				`/apiv1/deployments/${encodeURIComponent(deploymentId)}/metrics?start=${start}&end=${end}&step=${STEP_MS}`
			);
			if (!res.ok) return;
			const body = await res.json();
			const ys = (points: Point[] | undefined) => (points ?? []).map((p) => p.y);
			this.cpu = [...ys(body?.data?.cpu), ...this.cpu].slice(-MAX_POINTS);
			this.mem = [...ys(body?.data?.mem), ...this.mem].slice(-MAX_POINTS);
		} catch {
			this.#loadedFor = '';
		}
	}

	push(cpuMilli: number | null | undefined, memBytes: number | null | undefined) {
		if (cpuMilli != null) this.cpu = [...this.cpu, cpuMilli].slice(-MAX_POINTS);
		if (memBytes != null) this.mem = [...this.mem, memBytes / MIB].slice(-MAX_POINTS);
	}
}
