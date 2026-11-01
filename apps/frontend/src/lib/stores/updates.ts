import { derived, get, writable } from 'svelte/store';
import { parseUpdate, type Update } from '$lib/updates';
import { noteReleased } from '$lib/updates/version';
import { user } from './auth';
import { apiFetch } from './api';

export const latestUpdate = writable<Update | null>(null);

let requested = false;

export async function loadLatestUpdate() {
	if (requested) return;
	requested = true;
	try {
		const response = await apiFetch('/apiv1/updates/latest');
		if (!response.ok) return;
		const text = await response.text();
		const data = text ? JSON.parse(text) : null;
		const released = __ORCHARD_MOCK__ || noteReleased(String(data?.version ?? ''), __UI_VERSION__);
		latestUpdate.set(
			released && typeof data?.markdown === 'string' ? parseUpdate(data.markdown) : null
		);
	} catch (e) {
		requested = false;
		console.warn('Failed to load the latest release notes:', e);
	}
}

export const unseenUpdate = derived([user, latestUpdate], ([$user, $latest]) => {
	if (!$user || !$latest) return null;
	return ($user.seenUpdates ?? []).includes($latest.id) ? null : $latest;
});

export async function markUpdateSeen(id: string) {
	const current = get(user);
	if (!current) return;
	if ((current.seenUpdates ?? []).includes(id)) return;

	user.set({ ...current, seenUpdates: [...(current.seenUpdates ?? []), id] });

	try {
		const response = await apiFetch('/apiv1/auth/me/seen-updates', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (!response.ok) throw new Error(`Failed with ${response.status}`);
		const data = await response.json();
		const latest = get(user);
		if (latest && Array.isArray(data?.seenUpdates)) {
			user.set({ ...latest, seenUpdates: data.seenUpdates });
		}
	} catch (e) {
		console.warn('Failed to record update as seen:', e);
	}
}
