import { apiFetch } from '$lib/stores';
import type { SsoProvider } from './sso-types';

async function send(url: string, init: RequestInit, fallback: string): Promise<SsoProvider> {
	const res = await apiFetch(url, init);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.message || fallback);
	return data as SsoProvider;
}

export function uploadProviderIcon(providerUrl: string, file: File) {
	const body = new FormData();
	body.append('file', file);
	return send(`${providerUrl}/icon`, { method: 'POST', body }, 'Could not upload the icon');
}

export function removeProviderIcon(providerUrl: string) {
	return send(`${providerUrl}/icon`, { method: 'DELETE' }, 'Could not remove the icon');
}
