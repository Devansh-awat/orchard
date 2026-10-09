import { readable, type Readable } from 'svelte/store';
import type { PostHog } from 'posthog-js';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { scrubDeep, scrubUrlSecrets } from '$lib/utils/url-secrets';
import { whenIdle } from '$lib/utils/idle';

const MAX_PENDING = 100;

let scheduled = false;
let client: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;
const pending: Array<(posthog: PostHog) => void> = [];
const waiters = new Set<(posthog: PostHog) => void>();
let detachEarlyErrors: (() => void) | null = null;

function enabled(): boolean {
	return browser && !!env.PUBLIC_POSTHOG_KEY;
}

function start(posthog: PostHog, key: string) {
	posthog.init(key, {
		api_host: env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
		ui_host: 'https://us.posthog.com',
		defaults: '2025-05-24',
		capture_pageview: 'history_change',
		person_profiles: 'identified_only',
		capture_performance: { web_vitals: true, network_timing: true },
		disable_surveys: false,
		advanced_disable_feature_flags: false,
		disable_capture_url_hashes: true,
		before_send: (event) => {
			if (!event) return event;
			event.properties = scrubDeep(event.properties);
			if (event.$set) event.$set = scrubDeep(event.$set);
			if (event.$set_once) event.$set_once = scrubDeep(event.$set_once);
			return event;
		},
		session_recording: {
			maskCapturedNetworkRequestFn: (request) => {
				const headers = request.requestHeaders
					? Object.fromEntries(
							Object.entries(request.requestHeaders).filter(
								([key]) => key.toLowerCase() !== 'x-orchard-share-token'
							)
						)
					: request.requestHeaders;
				return {
					...request,
					name: scrubUrlSecrets(request.name),
					requestHeaders: headers,
					requestBody: request.requestBody?.includes('token') ? null : request.requestBody
				};
			}
		}
	});
}

function load(): Promise<PostHog | null> {
	const key = env.PUBLIC_POSTHOG_KEY;
	if (!browser || !key) return Promise.resolve(null);
	loading ??= import('posthog-js')
		.then(({ default: posthog }) => {
			start(posthog, key);
			client = posthog;
			detachEarlyErrors?.();
			detachEarlyErrors = null;
			for (const run of pending.splice(0)) run(posthog);
			for (const run of [...waiters]) run(posthog);
			waiters.clear();
			return posthog;
		})
		.catch((error) => {
			console.warn('PostHog failed to load', error);
			return null;
		});
	return loading;
}

function withClient(run: (posthog: PostHog) => void) {
	if (client) {
		run(client);
		return;
	}
	if (!enabled() || pending.length >= MAX_PENDING) return;
	pending.push(run);
}

function onReady(run: (posthog: PostHog) => void): () => void {
	if (client) {
		run(client);
		return () => {};
	}
	if (!enabled()) return () => {};
	waiters.add(run);
	return () => waiters.delete(run);
}

function captureEarlyErrors(): () => void {
	const onError = (event: ErrorEvent) => {
		captureException(event.error ?? event.message, { $exception_source: 'window.onerror' });
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		captureException(event.reason, { $exception_source: 'window.onunhandledrejection' });
	};
	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);
	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}

export function initPostHog() {
	if (!enabled() || scheduled) return;
	scheduled = true;
	if (!client) detachEarlyErrors = captureEarlyErrors();
	whenIdle(() => load(), 4000);
}

export function identifyUser(user: {
	id: string;
	email?: string;
	name?: string;
	username?: string;
}) {
	withClient((posthog) =>
		posthog.identify(user.id, {
			email: user.email,
			name: user.name,
			username: user.username
		})
	);
}

export function resetPostHog() {
	withClient((posthog) => posthog.reset());
}

export function captureException(error: unknown, properties?: Record<string, unknown>) {
	const err = error instanceof Error ? error : new Error(String(error));
	withClient((posthog) => posthog.captureException(err, properties));
}

export function featureFlag(key: string): Readable<boolean> {
	return readable(false, (set) => {
		let off: (() => void) | null = null;
		const cancel = onReady((posthog) => {
			set(Boolean(posthog.isFeatureEnabled(key)));
			off = posthog.onFeatureFlags(() => set(Boolean(posthog.isFeatureEnabled(key))));
		});
		return () => {
			cancel();
			off?.();
		};
	});
}

export function experimentVariant(key: string): Readable<string | boolean | undefined> {
	return readable<string | boolean | undefined>(undefined, (set) => {
		let off: (() => void) | null = null;
		const cancel = onReady((posthog) => {
			set(posthog.getFeatureFlag(key));
			off = posthog.onFeatureFlags(() => set(posthog.getFeatureFlag(key)));
		});
		return () => {
			cancel();
			off?.();
		};
	});
}

export function isFeatureEnabledNow(key: string): boolean {
	return client ? Boolean(client.isFeatureEnabled(key)) : false;
}

export function reloadFeatureFlags() {
	withClient((posthog) => posthog.reloadFeatureFlags());
}

export interface EarlyAccessFeature {
	name: string;
	description: string;
	stage: string;
	documentationUrl: string | null;
	flagKey: string;
}

export async function loadEarlyAccessFeatures(): Promise<EarlyAccessFeature[]> {
	const posthog = await load();
	if (!posthog) return [];
	return new Promise((resolve) => {
		posthog.getEarlyAccessFeatures((features) => {
			resolve(
				(features ?? [])
					.filter((f): f is typeof f & { flagKey: string } => Boolean(f.flagKey))
					.map((f) => ({
						name: f.name,
						description: f.description,
						stage: f.stage,
						documentationUrl: f.documentationUrl ?? null,
						flagKey: f.flagKey
					}))
			);
		}, true);
	});
}

export function setEarlyAccessFeatureEnrollment(flagKey: string, enrolled: boolean) {
	withClient((posthog) => posthog.updateEarlyAccessFeatureEnrollment(flagKey, enrolled));
}

export async function loadActiveSurveys(): Promise<unknown[]> {
	const posthog = await load();
	if (!posthog) return [];
	return new Promise((resolve) => {
		posthog.getActiveMatchingSurveys((surveys) => resolve(surveys ?? []), true);
	});
}
