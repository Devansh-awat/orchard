import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const PROJECT_GRADIENT_KEY = 'project-gradient-enabled';

function loadBool(key: string, fallback: boolean): boolean {
	if (!browser) return fallback;
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === 'true';
	} catch {
		return fallback;
	}
}

function saveBool(key: string, value: boolean) {
	if (!browser) return;
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// ignore
	}
}

const gradientStore = writable<boolean>(loadBool(PROJECT_GRADIENT_KEY, true));

export const projectGradientEnabled = {
	subscribe: gradientStore.subscribe,
	set(value: boolean) {
		gradientStore.set(value);
		saveBool(PROJECT_GRADIENT_KEY, value);
	},
	toggle() {
		gradientStore.update((v) => {
			const next = !v;
			saveBool(PROJECT_GRADIENT_KEY, next);
			return next;
		});
	}
};
