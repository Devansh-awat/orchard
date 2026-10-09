import { derived, readable, type Readable } from 'svelte/store';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { featureFlag } from '$lib/posthog';
import { instanceFeatures } from '$lib/stores/instance-features';

export function sandboxEnvOverride(): boolean | null {
	if (env.PUBLIC_SANDBOX_ENABLED === 'true') return true;
	if (env.PUBLIC_SANDBOX_ENABLED === 'false') return false;
	return null;
}

export const greenhouseFlag: Readable<boolean> = env.PUBLIC_POSTHOG_KEY
	? featureFlag('greenhouse')
	: readable(true);

export const sandboxesOn: Readable<boolean> = derived(
	instanceFeatures,
	(features) => sandboxEnvOverride() ?? (dev || features.sandboxes)
);
