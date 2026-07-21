<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto, beforeNavigate } from '$app/navigation';
	import { page, updated } from '$app/stores';
	import {
		user,
		isSignedIn,
		organizations,
		apiFetch,
		initApiBase,
		pendingInvitations,
		themeStore
	} from '$lib/stores';
	import { ToastContainer, OnboardingModal } from '$lib/components';
	import SidebarDeck from '$lib/components/SidebarDeck.svelte';
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

	const publicRoutes = ['/invite', '/oauth/callback', '/sso', '/mcp', '/cli', '/auth/protect'];

	// After a deploy, the chunks a running tab knows about no longer exist
	// on the server, so client-side navigation loads nothing until a reload.
	// When a new build is detected, turn the next navigation into a full
	// page load so the tab picks up the new build transparently.
	beforeNavigate(({ willUnload, to }) => {
		if ($updated && !willUnload && to?.url) {
			location.href = to.url.href;
		}
	});

	$effect(() => {
		if (loading || $isSignedIn) return;
		const path = $page.url.pathname;
		if (path === '/' || publicRoutes.some((route) => path.startsWith(route))) return;
		goto('/', { replaceState: true });
	});

	onMount(async () => {
		if (!browser) return;
		try {
			// Initialize theme as early as possible to prevent flash
			themeStore.init();

			// Initialize PostHog analytics (no-op if PUBLIC_POSTHOG_KEY is unset)
			initPostHog();

			// Initialize API base from environment or default
			const apiBase = env.PUBLIC_API_BASE || '';
			initApiBase(apiBase);

			const orgSlug = $page.params.orgSlug;
			const userPromise = user.fetchUser();
			const orgsPromise = apiFetch('/apiv1/organizations/user').catch((e) => {
				console.error('Failed to load organizations:', e);
				return null;
			});

			await userPromise;

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

				const wantInvitations = !shouldSkipChecks($page.url.pathname) && $user?.setupCompleted;
				if (wantInvitations) {
					void pendingInvitations
						.fetchPending()
						.catch((e) => console.error('Failed to load pending invitations:', e));
				}

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
		} catch (e) {
			console.error('LAYOUT INIT FAILED:', e);
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Orchard Dashboard</title>
</svelte:head>

<QueryClientProvider client={queryClient}>
	{#if loading}
		<div
			class="flex h-screen items-center justify-center"
			style="background-color: var(--center-channel-bg);"
		>
			<div class="lds-ellipsis" style="color: var(--button-bg);">
				<div></div>
				<div></div>
				<div></div>
				<div></div>
			</div>
		</div>
	{:else if $isSignedIn && ($page.url.pathname.startsWith('/setup') || $page.url.pathname.startsWith('/auth/protect'))}
		{@render children()}
	{:else if $isSignedIn}
		<div class="flex h-screen overflow-hidden">
			<SidebarDeck />
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

<style>
	.lds-ellipsis,
	.lds-ellipsis div {
		box-sizing: border-box;
	}
	.lds-ellipsis {
		display: inline-block;
		position: relative;
		width: 80px;
		height: 80px;
	}
	.lds-ellipsis div {
		position: absolute;
		top: 33.33333px;
		width: 13.33333px;
		height: 13.33333px;
		border-radius: 50%;
		background: currentColor;
		animation-timing-function: cubic-bezier(0, 1, 1, 0);
	}
	.lds-ellipsis div:nth-child(1) {
		left: 8px;
		animation: lds-ellipsis1 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(2) {
		left: 8px;
		animation: lds-ellipsis2 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(3) {
		left: 32px;
		animation: lds-ellipsis2 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(4) {
		left: 56px;
		animation: lds-ellipsis3 0.6s infinite;
	}
	@keyframes lds-ellipsis1 {
		0% {
			transform: scale(0);
		}
		100% {
			transform: scale(1);
		}
	}
	@keyframes lds-ellipsis3 {
		0% {
			transform: scale(1);
		}
		100% {
			transform: scale(0);
		}
	}
	@keyframes lds-ellipsis2 {
		0% {
			transform: translate(0, 0);
		}
		100% {
			transform: translate(24px, 0);
		}
	}
</style>
