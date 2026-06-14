<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		user,
		isSignedIn,
		organizations,
		apiFetch,
		initApiBase,
		pendingInvitations,
		themeStore
	} from '$lib/stores';
	import { Sidebar, ToastContainer, OnboardingModal } from '$lib/components';
	import QuickSearch from '$lib/components/QuickSearch.svelte';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { env } from '$env/dynamic/public';
	import { initPostHog, identifyUser } from '$lib/posthog';

	let { children } = $props();

	let loading = $state(true);

	// Don't check for pending invitations or redirect on these routes
	const skipRoutes = ['/invite', '/oauth/callback', '/setup', '/mcp/authorize'];

	function shouldSkipChecks(pathname: string): boolean {
		return skipRoutes.some((route) => pathname.startsWith(route));
	}

	onMount(async () => {
		if (!browser) return;

		// Initialize theme as early as possible to prevent flash
		themeStore.init();

		// Initialize PostHog analytics (no-op if PUBLIC_POSTHOG_KEY is unset)
		initPostHog();

		// Initialize API base from environment or default
		const apiBase = env.PUBLIC_API_BASE || '';
		initApiBase(apiBase);

		// Kick off every independent, cookie-authed request at once rather than
		// chaining auth/me → orgs → page-data. The API authorizes each request
		// server-side, so firing these before auth/me resolves is safe (an
		// unauthenticated session just gets 401s). This collapses a ~3-call
		// serial waterfall into a single parallel batch.
		const orgSlug = $page.params.orgSlug;
		const userPromise = user.fetchUser();
		const orgsPromise = apiFetch('/apiv1/organizations/user').catch((e) => {
			console.error('Failed to load organizations:', e);
			return null;
		});
		// Warm the overview cache in parallel so the dashboard paints its
		// content the moment the shell is ready, instead of starting a cold
		// fetch only after orgs resolve. Same query key the page uses.
		if (orgSlug) {
			void queryClient.prefetchQuery(overviewQueryOptions(orgSlug)).catch(() => {});
		}

		// Fetch user data
		await userPromise;

		// If user is signed in, fetch organizations and check for pending invitations
		if ($isSignedIn && $user) {
			identifyUser({
				id: $user.id,
				email: $user.email ?? $user.primaryEmailAddress?.emailAddress,
				name: $user.fullName ?? $user.name,
				username: $user.username
			});
		}
		if ($isSignedIn) {
			// Redirect to setup if not completed (unless already on setup/invite/callback)
			if ($user?.setupCompleted === false && !shouldSkipChecks($page.url.pathname)) {
				goto('/setup', { replaceState: true });
				loading = false;
				return;
			}

			// Pending invitations only feed a modal — they must NOT gate first
			// paint. Awaiting them here held the whole app behind the loading
			// spinner for the duration of that call (~1.5s in prod), even
			// though nothing on screen depends on it. Fire-and-forget; the
			// modal appears reactively once it resolves.
			const wantInvitations =
				!shouldSkipChecks($page.url.pathname) && $user?.setupCompleted;
			if (wantInvitations) {
				void pendingInvitations
					.fetchPending()
					.catch((e) => console.error('Failed to load pending invitations:', e));
			}

			// Orgs DO gate first paint — the sidebar needs them. The request was
			// already fired in parallel above; here we just consume it.
			try {
				const response = await orgsPromise;
				if (response?.ok) {
					const orgs = await response.json();
					organizations.set(orgs);
					organizations.initializeSelected(orgSlug);
				}
			} catch (e) {
				console.error('Failed to load organizations:', e);
			}
		}

		loading = false;
	});
</script>

<svelte:head>
	<title>Orchard Dashboard</title>
</svelte:head>

<QueryClientProvider client={queryClient}>
	{#if loading}
		<div class="flex h-screen items-center justify-center" style="background-color: var(--center-channel-bg);">
			<div class="lds-ellipsis" style="color: var(--button-bg);">
				<div></div><div></div><div></div><div></div>
			</div>
		</div>
	{:else if $isSignedIn && $page.url.pathname.startsWith('/setup')}
		{@render children()}
	{:else if $isSignedIn}
		<div class="flex h-screen overflow-hidden">
			<Sidebar />
			<main class="flex-1 overflow-y-auto overflow-x-hidden">
				{@render children()}
			</main>
		</div>
	{:else}
		<main class="min-h-screen">
			{@render children()}
		</main>
	{/if}

	<ToastContainer />
	<OnboardingModal />
	<QuickSearch />
</QueryClientProvider>