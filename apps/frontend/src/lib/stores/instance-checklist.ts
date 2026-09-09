import { writable, derived, get } from 'svelte/store';
import { apiFetch } from './api';

export interface InstanceChecklistItem {
	id: string;
	title: string;
	detail: string;
	done: boolean;
	severity: 'normal' | 'warning';
	href?: string;
}

const items = writable<InstanceChecklistItem[]>([]);
let loaded = false;

export const instanceChecklist = {
	subscribe: items.subscribe,
	async load(force = false) {
		if (loaded && !force) return get(items);
		const response = await apiFetch('/apiv1/setup/checklist');
		if (!response.ok) return get(items);
		loaded = true;
		const next = (await response.json()) as InstanceChecklistItem[];
		items.set(next);
		return next;
	}
};

export const instanceChecklistOutstanding = derived(items, ($items) =>
	$items.filter((item) => !item.done)
);

export const instanceChecklistWarnings = derived(instanceChecklistOutstanding, ($outstanding) =>
	$outstanding.filter((item) => item.severity === 'warning')
);
