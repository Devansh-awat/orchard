export type Cue = 'success' | 'error' | 'ready';

export const CUE_MIN_GAP_MS = 2000;

export function cueForBuildStatus(status: unknown): Cue | null {
	if (status === 'succeeded') return 'success';
	if (status === 'failed') return 'error';
	return null;
}

export interface BuildCueContext {
	focusedDeploymentId: string | null;
	watched: ReadonlySet<string>;
}

export function cueForBuildEvent(
	ev: { type: string; id?: string; payload?: { buildStatus?: unknown } | null },
	ctx: BuildCueContext
): Cue | null {
	if (ev.type !== 'build.changed' || !ev.id) return null;
	const cue = cueForBuildStatus(ev.payload?.buildStatus);
	if (!cue) return null;
	if (ev.id !== ctx.focusedDeploymentId && !ctx.watched.has(ev.id)) return null;
	return cue;
}

export class CueGate {
	private readonly last = new Map<string, number>();

	constructor(private readonly minGapMs = CUE_MIN_GAP_MS) {}

	allow(cue: string, now: number): boolean {
		const prev = this.last.get(cue);
		if (prev !== undefined && now - prev < this.minGapMs) return false;
		this.last.set(cue, now);
		return true;
	}
}
