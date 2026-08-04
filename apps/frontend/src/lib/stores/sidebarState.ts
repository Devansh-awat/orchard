import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'sidebar-collapsed';

function loadFromStorage(): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

function saveToStorage(value: boolean) {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, String(value));
	} catch {
		// ignore
	}
}

const store = writable<boolean>(loadFromStorage());

export const MOBILE_NAV_QUERY = '(max-width: 899px)';

const mobileNav = writable<boolean>(false);

export const mobileNavOpen = {
	subscribe: mobileNav.subscribe,
	open: () => mobileNav.set(true),
	close: () => mobileNav.set(false),
	toggle: () => mobileNav.update((v) => !v)
};

export const sidebarCollapsed = {
	subscribe: store.subscribe,
	set(value: boolean) {
		store.set(value);
		saveToStorage(value);
	},
	toggle() {
		store.update((v) => {
			const next = !v;
			saveToStorage(next);
			return next;
		});
	}
};
