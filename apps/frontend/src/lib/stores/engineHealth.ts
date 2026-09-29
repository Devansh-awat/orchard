import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { apiFetch } from './api';
import { subscribeOrgEvents } from './orgEvents';

import {
	settle,
	CONFIRM_MS,
	POLL_MS,
	type EngineHealth,
	type Settled
} from './engineHealth.settle';

export { settle, CONFIRM_MS, POLL_MS, type EngineHealth, type Settled };

const store = writable<EngineHealth>({ stale: false, shards: [] });
let state: Settled = { shown: { stale: false, shards: [] }, pendingSince: null };
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh() {
	try {
		const res = await apiFetch('/apiv1/engine/health');
		if (!res.ok) return;
		const data = await res.json();
		const shards = (data.shards ?? []) as EngineHealth['shards'];
		state = settle(state, { stale: shards.some((s) => s.stale), shards }, Date.now());
		store.set(state.shown);
		if (state.pendingSince !== null && !confirmTimer) {
			confirmTimer = setTimeout(() => {
				confirmTimer = null;
				void refresh();
			}, CONFIRM_MS + 250);
		}
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
	if (confirmTimer) clearTimeout(confirmTimer);
	timer = null;
	confirmTimer = null;
	started = false;
}
