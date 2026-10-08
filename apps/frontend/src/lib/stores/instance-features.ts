import { writable, get } from 'svelte/store';
import { apiFetch } from './api';

export interface InstanceFeatures {
	mcp: boolean;
	sandboxes: boolean;
}

const features = writable<InstanceFeatures>({ mcp: true, sandboxes: false });
let loaded = false;

export const instanceFeatures = {
	subscribe: features.subscribe,
	async load(force = false) {
		if (loaded && !force) return get(features);
		const response = await apiFetch('/apiv1/instance/features');
		if (!response.ok) return get(features);
		loaded = true;
		const next = {
			mcp: true,
			sandboxes: false,
			...((await response.json()) as Partial<InstanceFeatures>)
		};
		features.set(next);
		return next;
	}
};
