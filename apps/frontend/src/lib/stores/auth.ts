import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { apiBase, apiFetch, onUnauthorized } from './api';

export interface User {
	id: string;
	email: string;
	name?: string;
	username?: string;
	firstName?: string;
	lastName?: string;
	imageUrl?: string;
	fullName?: string;
	primaryEmailAddress?: { emailAddress: string };
	isSuperAdmin?: boolean;
	setupCompleted?: boolean;
	seenUpdates?: string[];
	homeOrganizationId?: string;
	sessionOrganizationId?: string;
	passkeyOnly?: boolean;
	emailDomainOwner?: { domain: string; organization: string };
}

function createAuthStore() {
	const { subscribe, set } = writable<User | null>(null);
	const loading = writable(true);
	const error = writable<string | null>(null);

	async function fetchUser() {
		if (!browser) return;

		loading.set(true);
		error.set(null);

		try {
			const response = await apiFetch('/apiv1/auth/me');

			if (!response.ok) {
				if (response.status === 401) {
					set(null);
					return;
				}
				throw new Error("Couldn't load user");
			}

			const userData = await response.json();
			set(userData);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Couldn't load user";
			error.set(message);
			set(null);
		} finally {
			loading.set(false);
		}
	}

	function signIn() {
		if (browser) {
			window.location.href = `${get(apiBase)}/apiv1/auth/login`;
		}
	}

	async function signOut() {
		if (!browser) return;
		import('$lib/posthog').then(({ resetPostHog }) => resetPostHog()).catch(() => {});
		try {
			await fetch(`${get(apiBase)}/apiv1/auth/logout`, {
				method: 'POST',
				credentials: 'include'
			});
		} catch {}
		set(null);
		window.location.href = '/';
	}

	async function getToken(): Promise<string | null> {
		return null;
	}

	return {
		subscribe,
		loading: { subscribe: loading.subscribe },
		error: { subscribe: error.subscribe },
		fetchUser,
		signIn,
		signOut,
		getToken,
		set
	};
}

export const user = createAuthStore();

let sessionExpiryHandled = false;
onUnauthorized((path) => {
	if (!browser || sessionExpiryHandled || path.startsWith('/apiv1/auth/')) return;
	if (!get(user)) return;
	sessionExpiryHandled = true;
	window.location.assign(`/?error=${encodeURIComponent('Your session expired. Sign in again.')}`);
});

export const isSignedIn = derived(user, ($user) => $user !== null);
export const isLoaded = derived(user.loading, ($loading) => !$loading);
export const isSuperAdmin = derived(user, ($user) => $user?.isSuperAdmin === true);
