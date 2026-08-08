import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { apiFetch } from './api';
import { subscribeOrgEvents } from './orgEvents';

export interface EngineHealth {
	stale: boolean;
	shards: { shard: string; holder: string | null; stale: boolean }[];
}

const POLL_MS = 60_000;

const store = writable<EngineHealth>({ stale: false, shards: [] });
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
	try {
		const res = await apiFetch('/apiv1/engine/health');
		if (!res.ok) return;
		const data = await res.json();
		const shards = (data.shards ?? []) as EngineHealth['shards'];
		store.set({ stale: shards.some((s) => s.stale), shards });
	} catch {}
}

export function engineHealth(orgId: () => string | undefined): Readable<EngineHealth> {
	if (browser && !started) {
		started = true;
		void refresh();
		timer = setInterval(() => {
			void refresh();
		}, POLL_MS);
		const id = orgId();
		if (id) {
			subscribeOrgEvents(id, (ev) => {
				if (ev.type === 'engine.changed') void refresh();
			});
		}
	}
	return { subscribe: store.subscribe };
}

export function stopEngineHealth() {
	if (timer) clearInterval(timer);
	timer = null;
	started = false;
}
