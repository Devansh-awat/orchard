import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';

export function sandboxEnabled(): boolean {
	if (env.PUBLIC_SANDBOX_ENABLED === 'true') return true;
	if (env.PUBLIC_SANDBOX_ENABLED === 'false') return false;
	return dev;
}
