import { writable, get } from 'svelte/store';

export type ToastColor = 'success' | 'error' | 'warning' | 'info' | 'loading';

export type ToastPosition =
	| 'top-left'
	| 'top-center'
	| 'top-right'
	| 'bottom-left'
	| 'bottom-center'
	| 'bottom-right';

export interface Toast {
	id: string;
	title: string;
	description?: string;
	color: ToastColor;
	duration?: number;
	position?: ToastPosition;
	action?: { label: string; onClick: () => void };
	exiting?: boolean;
	version?: number;
}

export type ToastInput = Omit<Toast, 'id' | 'exiting' | 'version'>;

export const TOAST_DURATION = 6000;
export const TOAST_EXIT_MS = 420;
export const DEFAULT_POSITION: ToastPosition = 'bottom-right';

type Timer = { remaining: number; started: number; handle?: ReturnType<typeof setTimeout> };

function createToastStore() {
	const store = writable<Toast[]>([]);
	const timers = new Map<string, Timer>();
	let paused = false;
	let seq = 0;

	function disarm(id: string) {
		const timer = timers.get(id);
		if (timer?.handle) clearTimeout(timer.handle);
		timers.delete(id);
	}

	function arm(id: string, ms: number) {
		disarm(id);
		const timer: Timer = { remaining: ms, started: Date.now() };
		if (!paused) timer.handle = setTimeout(() => remove(id), ms);
		timers.set(id, timer);
	}

	function lifetime(toast: Pick<Toast, 'color' | 'duration'>) {
		return toast.duration ?? (toast.color === 'loading' ? 0 : TOAST_DURATION);
	}

	function add(toast: ToastInput) {
		const id = `t${++seq}`;
		store.update((list) => [...list, { ...toast, id, version: 0 }]);
		const ms = lifetime(toast);
		if (ms > 0) arm(id, ms);
		return id;
	}

	function update(id: string, patch: Partial<ToastInput>) {
		let next: Toast | undefined;
		store.update((list) =>
			list.map((t) => {
				if (t.id !== id) return t;
				next = { ...t, ...patch, version: (t.version ?? 0) + 1 };
				return next;
			})
		);
		if (!next) return;
		const ms = lifetime(next);
		if (ms > 0) arm(id, ms);
		else disarm(id);
	}

	function remove(id: string) {
		disarm(id);
		const target = get(store).find((t) => t.id === id);
		if (!target || target.exiting) return;
		store.update((list) => list.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
		setTimeout(() => store.update((list) => list.filter((t) => t.id !== id)), TOAST_EXIT_MS);
	}

	function clear() {
		for (const id of [...timers.keys()]) disarm(id);
		for (const t of get(store)) remove(t.id);
	}

	function pause() {
		if (paused) return;
		paused = true;
		const now = Date.now();
		for (const timer of timers.values()) {
			if (!timer.handle) continue;
			clearTimeout(timer.handle);
			timer.handle = undefined;
			timer.remaining = Math.max(0, timer.remaining - (now - timer.started));
		}
	}

	function resume() {
		if (!paused) return;
		paused = false;
		for (const [id, timer] of timers) {
			timer.started = Date.now();
			timer.handle = setTimeout(() => remove(id), Math.max(timer.remaining, 1500));
		}
	}

	async function promise<T>(
		work: Promise<T>,
		copy: {
			loading: string;
			success: string | ((value: T) => string);
			error: string | ((error: unknown) => string);
			description?: string;
			position?: ToastPosition;
		}
	): Promise<T> {
		const id = add({ title: copy.loading, color: 'loading', position: copy.position });
		try {
			const value = await work;
			const title = typeof copy.success === 'function' ? copy.success(value) : copy.success;
			update(id, { color: 'success', title, description: copy.description });
			return value;
		} catch (error) {
			const title = typeof copy.error === 'function' ? copy.error(error) : copy.error;
			update(id, { color: 'error', title });
			throw error;
		}
	}

	return { subscribe: store.subscribe, add, update, remove, clear, pause, resume, promise };
}

export const toasts = createToastStore();
