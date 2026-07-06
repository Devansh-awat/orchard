import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export const apiBase = writable(browser ? '' : '');

export function initApiBase(base: string) {
	apiBase.set(base);
}

let unauthorizedHandler: ((path: string) => void) | null = null;

export function onUnauthorized(handler: (path: string) => void) {
	unauthorizedHandler = handler;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const base = get(apiBase);
	const url = `${base}${path}`;

	const response = await fetch(url, {
		...options,
		credentials: 'include',
		headers: {
			...options.headers
		}
	});
	if (response.status === 401) unauthorizedHandler?.(path);
	return response;
}
