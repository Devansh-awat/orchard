import { readable, type Readable } from 'svelte/store';
import posthog from 'posthog-js';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { scrubDeep, scrubUrlSecrets } from '$lib/utils/url-secrets';

let initialized = false;

export function initPostHog() {
	if (!browser || initialized) return;
	const key = env.PUBLIC_POSTHOG_KEY;
	if (!key) return;
	posthog.init(key, {
		api_host: env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
		ui_host: 'https://us.posthog.com',
		defaults: '2025-05-24',
		capture_pageview: 'history_change',
		person_profiles: 'identified_only',
		// 2025-05-24 defaults already enable capture_exceptions + dead clicks.
		// We additionally turn on Web Vitals (LCP/CLS/INP/FCP) and explicit
		// network timing so PostHog's performance dashboards have data.
		capture_performance: { web_vitals: true, network_timing: true },
		// Flags + experiments are auto-loaded; surveys auto-render in the DOM.
		// Early access features are opt-in via getEarlyAccessFeatures() below.
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
	initialized = true;
}

export function identifyUser(user: {
	id: string;
	email?: string;
	name?: string;
	username?: string;
}) {
	if (!browser || !initialized) return;
	posthog.identify(user.id, {
		email: user.email,
		name: user.name,
		username: user.username
	});
}

export function resetPostHog() {
	if (!browser || !initialized) return;
	posthog.reset();
}

/** Send an exception to PostHog Error Tracking with optional context. */
export function captureException(error: unknown, properties?: Record<string, unknown>) {
	if (!browser || !initialized) return;
	const err = error instanceof Error ? error : new Error(String(error));
	posthog.captureException(err, properties);
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flags & experiments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reactive store for a boolean feature flag. Updates when flags reload
 * (login, identify, manual reload).
 */
export function featureFlag(key: string): Readable<boolean> {
	return readable(false, (set) => {
		if (!browser || !initialized) return;
		set(Boolean(posthog.isFeatureEnabled(key)));
		return posthog.onFeatureFlags(() => set(Boolean(posthog.isFeatureEnabled(key))));
	});
}

/**
 * Reactive store for a multivariate flag / experiment variant. Returns the
 * variant string (e.g. 'control', 'treatment-a'), `true`/`false` for boolean
 * flags, or `undefined` while loading.
 */
export function experimentVariant(key: string): Readable<string | boolean | undefined> {
	return readable<string | boolean | undefined>(undefined, (set) => {
		if (!browser || !initialized) return;
		set(posthog.getFeatureFlag(key));
		return posthog.onFeatureFlags(() => set(posthog.getFeatureFlag(key)));
	});
}

/** Imperative one-shot check — use when a Svelte store is overkill. */
export function isFeatureEnabledNow(key: string): boolean {
	if (!browser || !initialized) return false;
	return Boolean(posthog.isFeatureEnabled(key));
}

/** Force a flag reload — call after server-side state changes that affect targeting. */
export function reloadFeatureFlags() {
	if (!browser || !initialized) return;
	posthog.reloadFeatureFlags();
}

// ─────────────────────────────────────────────────────────────────────────────
// Early access features (beta opt-in UI)
// ─────────────────────────────────────────────────────────────────────────────

export interface EarlyAccessFeature {
	name: string;
	description: string;
	stage: string;
	documentationUrl: string | null;
	flagKey: string;
}

export function loadEarlyAccessFeatures(): Promise<EarlyAccessFeature[]> {
	return new Promise((resolve) => {
		if (!browser || !initialized) {
			resolve([]);
			return;
		}
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
	if (!browser || !initialized) return;
	posthog.updateEarlyAccessFeatureEnrollment(flagKey, enrolled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Surveys — autorenders by default; expose helpers for in-app triggers
// ─────────────────────────────────────────────────────────────────────────────

export function loadActiveSurveys(): Promise<unknown[]> {
	return new Promise((resolve) => {
		if (!browser || !initialized) {
			resolve([]);
			return;
		}
		posthog.getActiveMatchingSurveys((surveys) => resolve(surveys ?? []), true);
	});
}

export { posthog };
