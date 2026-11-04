import { derived, writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { featureFlag } from '$lib/posthog';
import { apiFetch } from './api';

export interface InstanceFeatures {
	mcp: boolean;
	sandboxes: boolean;
	earlyAccessOpen: boolean;
	fastBuilder: boolean;
}

const features = writable<InstanceFeatures>({
	mcp: true,
	sandboxes: false,
	earlyAccessOpen: false,
	fastBuilder: false
});
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
			earlyAccessOpen: false,
			fastBuilder: false,
			...((await response.json()) as Partial<InstanceFeatures>)
		};
		features.set(next);
		return next;
	}
};

export function earlyAccessFlag(key: string): Readable<boolean> {
	if (browser) instanceFeatures.load().catch(() => undefined);
	return derived(
		[features, featureFlag(key)],
		([$features, $enabled]) => $features.earlyAccessOpen || $enabled
	);
}
