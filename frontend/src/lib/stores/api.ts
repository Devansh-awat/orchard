import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export const apiBase = writable(browser ? '' : '');

export function initApiBase(base: string) {
	apiBase.set(base);
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const base = get(apiBase);
	const url = `${base}${path}`;

	return fetch(url, {
		...options,
		credentials: 'include',
		headers: {
			...options.headers
		}
	});
}
