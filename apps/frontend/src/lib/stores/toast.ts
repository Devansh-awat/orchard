import { writable, get } from 'svelte/store';

export type ToastColor = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface Toast {
	id: string;
	title: string;
	description?: string;
	color: ToastColor;
	duration?: number;
	action?: { label: string; onClick: () => void };
}

type Timer = { remaining: number; started: number; handle?: ReturnType<typeof setTimeout> };

function createToastStore() {
	const store = writable<Toast[]>([]);
	const timers = new Map<string, Timer>();
	let paused = false;

	function arm(id: string, ms: number) {
		const timer: Timer = { remaining: ms, started: Date.now() };
		if (!paused) timer.handle = setTimeout(() => remove(id), ms);
		timers.set(id, timer);
	}

	function add(toast: Omit<Toast, 'id'>) {
		const id = Math.random().toString(36).substring(2, 9);
		store.update((list) => [...list, { ...toast, id }]);
		const duration = toast.duration ?? (toast.color === 'loading' ? 0 : 5000);
		if (duration > 0) arm(id, duration);
		return id;
	}

	function update(id: string, patch: Partial<Omit<Toast, 'id'>>) {
		store.update((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
		const existing = timers.get(id);
		if (existing?.handle) clearTimeout(existing.handle);
		timers.delete(id);
		const next = get(store).find((t) => t.id === id);
		if (!next) return;
		const duration = patch.duration ?? (next.color === 'loading' ? 0 : 5000);
		if (duration > 0) arm(id, duration);
	}

	function remove(id: string) {
		const timer = timers.get(id);
		if (timer?.handle) clearTimeout(timer.handle);
		timers.delete(id);
		store.update((list) => list.filter((t) => t.id !== id));
	}

	function clear() {
		for (const timer of timers.values()) if (timer.handle) clearTimeout(timer.handle);
		timers.clear();
		store.set([]);
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
			timer.handle = setTimeout(() => remove(id), Math.max(timer.remaining, 1200));
		}
	}

	async function promise<T>(
		work: Promise<T>,
		copy: {
			loading: string;
			success: string | ((value: T) => string);
			error: string | ((error: unknown) => string);
		}
	): Promise<T> {
		const id = add({ title: copy.loading, color: 'loading' });
		try {
			const value = await work;
			update(id, {
				color: 'success',
				title: typeof copy.success === 'function' ? copy.success(value) : copy.success
			});
			return value;
		} catch (error) {
			update(id, {
				color: 'error',
				title: typeof copy.error === 'function' ? copy.error(error) : copy.error
			});
			throw error;
		}
	}

	return { subscribe: store.subscribe, add, update, remove, clear, pause, resume, promise };
}

export const toasts = createToastStore();
