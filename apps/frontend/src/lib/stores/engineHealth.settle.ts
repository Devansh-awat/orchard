export interface EngineHealth {
	stale: boolean;
	shards: { shard: string; holder: string | null; stale: boolean }[];
}

export const POLL_MS = 60_000;
export const CONFIRM_MS = 10_000;

export interface Settled {
	shown: EngineHealth;
	pendingSince: number | null;
}

export function settle(prev: Settled, reported: EngineHealth, now: number): Settled {
	if (!reported.stale) return { shown: reported, pendingSince: null };
	if (prev.shown.stale) return { shown: reported, pendingSince: null };
	if (prev.pendingSince === null) {
		return { shown: { ...reported, stale: false }, pendingSince: now };
	}
	if (now - prev.pendingSince >= CONFIRM_MS) return { shown: reported, pendingSince: null };
	return { shown: { ...reported, stale: false }, pendingSince: prev.pendingSince };
}
