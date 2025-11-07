<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import {
		user,
		isSignedIn,
		organizations,
		apiFetch,
		initApiBase,
		pendingInvitations,
		showPendingInvitationsModal,
		themeStore
	} from '$lib/stores';
	import { Sidebar, ToastContainer, PendingInvitationsModal, OnboardingModal } from '$lib/components';
	import { Loader2 } from 'lucide-svelte';

	let { children } = $props();

	let loading = $state(true);

	// Don't check for pending invitations on these routes
	const skipInvitationCheckRoutes = ['/invite', '/oauth/callback'];

	function shouldSkipInvitationCheck(pathname: string): boolean {
		return skipInvitationCheckRoutes.some((route) => pathname.startsWith(route));
	}

	onMount(async () => {
		if (!browser) return;

		// Initialize theme as early as possible to prevent flash
		themeStore.init();

		// Initialize API base from environment or default
		const apiBase = import.meta.env.VITE_API_BASE || '';
		initApiBase(apiBase);

		// Fetch user data
		await user.fetchUser();

		// If user is signed in, fetch organizations and check for pending invitations
		if ($isSignedIn) {
			try {
				const response = await apiFetch('/apiv1/organizations/user');
				if (response.ok) {
					const orgs = await response.json();
					organizations.set(orgs);
					organizations.initializeSelected();
				}

				// Check for pending invitations (unless on invite or callback routes)
				if (!shouldSkipInvitationCheck($page.url.pathname)) {
					const pending = await pendingInvitations.fetchPending();
					if (pending.length > 0) {
						showPendingInvitationsModal.show();
					}
				}
			} catch (e) {
				console.error('Failed to fetch organizations:', e);
			}
		}

		loading = false;
	});
</script>

<svelte:head>
	<title>Orchard Dashboard</title>
</svelte:head>

{#if loading}
	<div class="flex h-screen items-center justify-center" style="background-color: var(--center-channel-bg);">
		<div class="text-center">
			<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
			<p class="mt-2 text-sm" style="color: var(--surface-muted);">Loading...</p>
		</div>
	</div>
{:else if $isSignedIn}
	<div class="flex h-screen overflow-hidden">
		<Sidebar />
		<main class="flex-1 overflow-y-auto">
			{@render children()}
		</main>
	</div>
{:else}
	<main class="min-h-screen">
		{@render children()}
	</main>
{/if}

<ToastContainer />
<PendingInvitationsModal />
<OnboardingModal />