import { derived, get } from 'svelte/store';
import { updates, type Update } from '$lib/updates';
import { user } from './auth';
import { apiFetch } from './api';

export const latestUpdate: Update | null = updates[0] ?? null;

export const unseenUpdate = derived(user, ($user) => {
	if (!$user || !latestUpdate) return null;
	return ($user.seenUpdates ?? []).includes(latestUpdate.id) ? null : latestUpdate;
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
