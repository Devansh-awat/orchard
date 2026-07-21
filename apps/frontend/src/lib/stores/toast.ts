import { writable } from 'svelte/store';

export interface Toast {
	id: string;
	title: string;
	description?: string;
	color: 'success' | 'error' | 'warning' | 'info';
	duration?: number;
	action?: { label: string; onClick: () => void };
}

function createToastStore() {
	const { subscribe, update } = writable<Toast[]>([]);

	function add(toast: Omit<Toast, 'id'>) {
		const id = Math.random().toString(36).substring(2, 9);
		const newToast: Toast = { ...toast, id };

		update((toasts) => [...toasts, newToast]);

		const duration = toast.duration ?? 5000;
		if (duration > 0) {
			setTimeout(() => {
				remove(id);
			}, duration);
		}

		return id;
	}

	function remove(id: string) {
		update((toasts) => toasts.filter((t) => t.id !== id));
	}

	function clear() {
		update(() => []);
	}

	return {
		subscribe,
		add,
		remove,
		clear
	};
}

export const toasts = createToastStore();
