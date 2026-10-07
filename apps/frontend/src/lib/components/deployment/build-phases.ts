export interface BuildPhase {
	id: string;
	label: string;
	ms: number;
	live: boolean;
}

const ORDER: { id: string; label: string; from: string; to: string }[] = [
	{ id: 'queue', label: 'Queue', from: '__start', to: 'submitted' },
	{ id: 'schedule', label: 'Builder', from: 'submitted', to: 'scheduled' },
	{ id: 'start', label: 'Start', from: 'scheduled', to: 'cloning' },
	{ id: 'clone', label: 'Clone', from: 'cloning', to: 'building' },
	{ id: 'build', label: 'Build', from: 'building', to: 'pushing' },
	{ id: 'push', label: 'Push', from: 'pushing', to: 'deploying' },
	{ id: 'rollout', label: 'Apply', from: 'deploying', to: 'complete' }
];

export function buildPhases(
	timestamps: Record<string, number> | null | undefined,
	now = Date.now(),
	running = false
): BuildPhase[] {
	if (!timestamps) return [];
	const out: BuildPhase[] = [];
	for (const p of ORDER) {
		const from = timestamps[p.from];
		if (typeof from !== 'number') continue;
		let to = timestamps[p.to];
		let live = false;
		if (typeof to !== 'number') {
			const later = ORDER.slice(ORDER.indexOf(p) + 1)
				.map((q) => timestamps[q.to])
				.find((v): v is number => typeof v === 'number');
			if (typeof later === 'number') to = later;
			else if (running) {
				to = now;
				live = true;
			} else continue;
		}
		out.push({ id: p.id, label: p.label, ms: Math.max(0, to - from), live });
		if (live) break;
	}
	return out;
}

export function formatPhase(ms: number): string {
	const s = ms / 1000;
	if (s < 1) return '<1s';
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${Math.round(s % 60)}s`;
}
