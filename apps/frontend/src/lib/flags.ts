import { readable, type Readable } from 'svelte/store';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { featureFlag } from '$lib/posthog';

export function sandboxEnabled(): boolean {
	if (env.PUBLIC_SANDBOX_ENABLED === 'true') return true;
	if (env.PUBLIC_SANDBOX_ENABLED === 'false') return false;
	return dev;
}

export const greenhouseFlag: Readable<boolean> = env.PUBLIC_POSTHOG_KEY
	? featureFlag('greenhouse')
	: readable(true);
