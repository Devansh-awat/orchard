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

		// Fetch user data
		await user.fetchUser();

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

			// Fire orgs + invitations in parallel — they don't depend on each
			// other, and serializing them added ~50ms to first paint for no
			// reason. fetchPending is only relevant once setup is done.
			const wantInvitations =
				!shouldSkipChecks($page.url.pathname) && $user?.setupCompleted;
			const orgsPromise = apiFetch('/apiv1/organizations/user').then(async (response) => {
				if (response.ok) {
					const orgs = await response.json();
					organizations.set(orgs);
					organizations.initializeSelected();
				}
			});
			const invitationsPromise = wantInvitations
				? pendingInvitations.fetchPending()
				: Promise.resolve();
			try {
				await Promise.all([orgsPromise, invitationsPromise]);
			} catch (e) {
				console.error('Failed to load layout data:', e);
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