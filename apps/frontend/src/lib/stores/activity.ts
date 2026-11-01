import { writable, get } from 'svelte/store';

export type ActivityStatus = 'running' | 'success' | 'error';

export type ActivityPhase = {
	id: string;
	label: string;
	ms: number;
	live?: boolean;
	since?: number;
};

export interface Activity {
	id: string;
	app: string;
	project: string;
	projectIcon?: string | null;
	phase: string;
	phaseId?: string;
	phases: ActivityPhase[];
	progress?: number;
	message?: string;
	detail?: string;
	title?: string;
	status: ActivityStatus;
	startedAt: number;
	finishedAt?: number;
	version: number;
}

export type ActivityInput = {
	app: string;
	project: string;
	projectIcon?: string | null;
	phase: string;
	phaseId?: string;
	phases?: ActivityPhase[];
	progress?: number;
	message?: string;
	detail?: string;
};

export type ActivityPatch = Partial<ActivityInput>;

export const ACTIVITY_SUCCESS_HOLD = 2600;

function slug(label: string) {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'work';
}

function settle(phases: ActivityPhase[], now: number): ActivityPhase[] {
	return phases.map((p) =>
		p.live ? { ...p, ms: p.ms + (p.since ? now - p.since : 0), live: false, since: undefined } : p
	);
}

function createActivityStore() {
	const store = writable<Activity[]>([]);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let seq = 0;

	function patchOne(id: string, fn: (a: Activity) => Activity) {
		store.update((list) =>
			list.map((a) => (a.id === id ? { ...fn(a), version: a.version + 1 } : a))
		);
	}

	function start(input: ActivityInput) {
		const id = `a${++seq}`;
		const now = Date.now();
		const phaseId = input.phaseId ?? slug(input.phase);
		const phases = input.phases ?? [
			{ id: phaseId, label: input.phase, ms: 0, live: true, since: now }
		];
		store.update((list) => [
			...list,
			{
				...input,
				id,
				phaseId,
				phases,
				status: 'running',
				startedAt: now,
				version: 0
			}
		]);
		return id;
	}

	function advance(a: Activity, label: string, phaseId: string | undefined, now: number) {
		const id = phaseId ?? slug(label);
		return {
			phase: label,
			phaseId: id,
			phases: [...settle(a.phases, now), { id, label, ms: 0, live: true, since: now }]
		};
	}

	function update(id: string, patch: ActivityPatch) {
		const now = Date.now();
		patchOne(id, (a) => {
			if (a.status !== 'running') return { ...a, ...patch, phases: patch.phases ?? a.phases };
			const moved = patch.phase !== undefined && patch.phase !== a.phase && !patch.phases;
			const next: Partial<ReturnType<typeof advance>> = moved
				? advance(a, patch.phase!, patch.phaseId, now)
				: {};
			return { ...a, ...patch, ...next, phases: patch.phases ?? next.phases ?? a.phases };
		});
	}

	function finish(
		id: string,
		status: Exclude<ActivityStatus, 'running'>,
		outcome?: string | { title?: string; message?: string }
	) {
		const now = Date.now();
		const { title, message } = typeof outcome === 'string' ? { message: outcome } : (outcome ?? {});
		patchOne(id, (a) => ({
			...a,
			status,
			title: title ?? a.title,
			message: message ?? a.message,
			phases: settle(a.phases, now),
			progress: status === 'success' ? 1 : a.progress,
			finishedAt: now
		}));
		clearTimeout(timers.get(id));
		timers.delete(id);
		if (status === 'success') {
			timers.set(
				id,
				setTimeout(() => dismiss(id), ACTIVITY_SUCCESS_HOLD)
			);
		}
	}

	function dismiss(id: string) {
		clearTimeout(timers.get(id));
		timers.delete(id);
		store.update((list) => list.filter((a) => a.id !== id));
	}

	function clear() {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		store.set([]);
	}

	function find(id: string) {
		return get(store).find((a) => a.id === id);
	}

	async function fromPromise<T>(
		work: Promise<T>,
		copy: Omit<ActivityInput, 'phase'> & {
			phase?: string;
			success?: string | ((value: T) => string);
			error?: string | ((error: unknown) => string);
		}
	): Promise<T> {
		const { success, error, phase = 'Working', ...rest } = copy;
		const id = start({ ...rest, phase });
		try {
			const value = await work;
			finish(id, 'success', { title: typeof success === 'function' ? success(value) : success });
			return value;
		} catch (e) {
			finish(id, 'error', { title: typeof error === 'function' ? error(e) : error });
			throw e;
		}
	}

	return { subscribe: store.subscribe, start, update, finish, dismiss, clear, find, fromPromise };
}

export const activity = createActivityStore();
