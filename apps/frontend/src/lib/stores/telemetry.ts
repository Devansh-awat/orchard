import { writable, get } from 'svelte/store';
import { apiFetch } from './api';

export interface TelemetryState {
	enabled: boolean;
	consent: 'granted' | 'denied' | null;
	envOverride: boolean | null;
	needsAnswer: boolean;
	destination: string;
}

export interface TelemetryPreview {
	event: string;
	distinctId: string;
	properties: Record<string, string | number | boolean | null>;
}

const state = writable<TelemetryState | null | undefined>(undefined);
let inflight: Promise<TelemetryState | null> | null = null;

async function fetchState(): Promise<TelemetryState | null> {
	try {
		const response = await apiFetch('/apiv1/admin/telemetry');
		const next = response.ok ? ((await response.json()) as TelemetryState) : null;
		state.set(next);
		return next;
	} catch {
		state.set(null);
		return null;
	}
}

export const telemetry = {
	subscribe: state.subscribe,
	ensure(): Promise<TelemetryState | null> {
		const current = get(state);
		if (current !== undefined) return Promise.resolve(current);
		inflight ??= fetchState().finally(() => {
			inflight = null;
		});
		return inflight;
	},
	reload(): Promise<TelemetryState | null> {
		return fetchState();
	},
	async answer(enabled: boolean): Promise<TelemetryState> {
		const response = await apiFetch('/apiv1/admin/telemetry', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(body?.message || 'Could not save your choice');
		}
		const next = (await response.json()) as TelemetryState;
		state.set(next);
		return next;
	},
	async preview(): Promise<TelemetryPreview | null> {
		const response = await apiFetch('/apiv1/admin/telemetry/preview');
		return response.ok ? ((await response.json()) as TelemetryPreview) : null;
	}
};
