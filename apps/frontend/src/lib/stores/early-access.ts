import { derived, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { featureFlag } from '$lib/posthog';
import { instanceFeatures } from './instance-features';

export function earlyAccessFlag(key: string): Readable<boolean> {
	if (browser) instanceFeatures.load().catch(() => undefined);
	return derived(
		[instanceFeatures, featureFlag(key)],
		([$features, $enabled]) => $features.earlyAccessOpen || $enabled
	);
}
