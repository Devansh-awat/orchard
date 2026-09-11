import { writable, get } from 'svelte/store';
import { apiFetch } from './api';

export interface InstanceFeatures {
	mcp: boolean;
}

const features = writable<InstanceFeatures>({ mcp: true });
let loaded = false;

export const instanceFeatures = {
	subscribe: features.subscribe,
	async load(force = false) {
		if (loaded && !force) return get(features);
		const response = await apiFetch('/apiv1/instance/features');
		if (!response.ok) return get(features);
		loaded = true;
		const next = (await response.json()) as InstanceFeatures;
		features.set(next);
		return next;
	}
};
