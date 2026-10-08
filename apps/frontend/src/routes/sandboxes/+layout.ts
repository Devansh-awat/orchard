import { redirect } from '@sveltejs/kit';
import { browser, dev } from '$app/environment';
import { sandboxEnvOverride } from '$lib/flags';
import { instanceFeatures } from '$lib/stores';

export const ssr = false;

export async function load() {
	const override = sandboxEnvOverride();
	if (override === false) redirect(302, '/');
	if (override === true || dev || !browser) return {};
	const features = await instanceFeatures.load(true).catch(() => null);
	if (!features?.sandboxes) redirect(302, '/');
	return {};
}
