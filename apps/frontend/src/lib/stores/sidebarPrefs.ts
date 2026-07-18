import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface SidebarPrefs {
	order: string[];
	hidden: string[];
}

const STORAGE_KEY = 'sidebar-prefs';
const DEFAULTS: SidebarPrefs = { order: [], hidden: [] };

function load(): SidebarPrefs {
	if (!browser) return DEFAULTS;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULTS;
		const parsed = JSON.parse(raw);
		return {
			order: Array.isArray(parsed.order) ? parsed.order : [],
			hidden: Array.isArray(parsed.hidden) ? parsed.hidden : []
		};
	} catch {
		return DEFAULTS;
	}
}

function save(prefs: SidebarPrefs) {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

const store = writable<SidebarPrefs>(load());

export const sidebarPrefs = {
	subscribe: store.subscribe,

	setOrder(order: string[]) {
		store.update((p) => {
			const next = { ...p, order };
			save(next);
			return next;
		});
	},

	toggleHidden(id: string) {
		store.update((p) => {
			const hidden = p.hidden.includes(id)
				? p.hidden.filter((h) => h !== id)
				: [...p.hidden, id];
			const next = { ...p, hidden };
			save(next);
			return next;
		});
	},

	reset() {
		save(DEFAULTS);
		store.set(DEFAULTS);
	}
};

export function applyPrefs<T extends { id: string }>(items: T[], prefs: SidebarPrefs): T[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const ordered: T[] = [];
	for (const id of prefs.order) {
		const item = byId.get(id);
		if (item) {
			ordered.push(item);
			byId.delete(id);
		}
	}
	for (const item of byId.values()) ordered.push(item);
	return ordered;
}
