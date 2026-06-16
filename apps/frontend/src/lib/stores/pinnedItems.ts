import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export interface PinnedItem {
	id: string;
	name: string;
	type: 'project' | 'deployment';
	href: string;
}

const STORAGE_KEY = 'pinned-sidebar-items';
const STORAGE_VERSION_KEY = 'pinned-sidebar-version';
const CURRENT_VERSION = 2; // Bumped for org-slug URL migration

function loadFromStorage(): PinnedItem[] {
	if (!browser) return [];
	try {
		const version = localStorage.getItem(STORAGE_VERSION_KEY);
		if (version !== String(CURRENT_VERSION)) {
			// Clear stale pinned items from old URL format
			localStorage.removeItem(STORAGE_KEY);
			localStorage.setItem(STORAGE_VERSION_KEY, String(CURRENT_VERSION));
			return [];
		}
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored ? JSON.parse(stored) : [];
	} catch {
		return [];
	}
}

function saveToStorage(items: PinnedItem[]) {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
	localStorage.setItem(STORAGE_VERSION_KEY, String(CURRENT_VERSION));
}

const store = writable<PinnedItem[]>(loadFromStorage());

export const pinnedItems = {
	subscribe: store.subscribe,

	pin(item: PinnedItem) {
		store.update((items) => {
			if (items.some((i) => i.id === item.id)) return items;
			const updated = [...items, item];
			saveToStorage(updated);
			return updated;
		});
	},

	unpin(id: string) {
		store.update((items) => {
			const updated = items.filter((i) => i.id !== id);
			saveToStorage(updated);
			return updated;
		});
	},

	toggle(item: PinnedItem) {
		const items = get(store);
		if (items.some((i) => i.id === item.id)) {
			this.unpin(item.id);
		} else {
			this.pin(item);
		}
	},

	isPinned(id: string): boolean {
		return get(store).some((i) => i.id === id);
	}
};
