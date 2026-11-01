<script lang="ts">
	import '../app.css';
	import 'blobatar/motion.css';
	import { onMount, tick, untrack } from 'svelte';
	import { browser, dev } from '$app/environment';
	import { goto, beforeNavigate } from '$app/navigation';
	import { page, updated } from '$app/stores';
	import {
		user,
		isSignedIn,
		organizations,
		apiFetch,
		initApiBase,
		pendingInvitations,
		themeStore,
		toasts
	} from '$lib/stores';
	import ToastContainer from '$lib/components/Toast.svelte';
	import OnboardingModal from '$lib/components/OnboardingModal.svelte';
	import SidebarDeck from '$lib/components/SidebarDeck.svelte';
	import { signingIn } from '$lib/components/login/signing-in';
	import MobileTopBar from '$lib/components/MobileTopBar.svelte';
	import LogTimestampTooltip from '$lib/components/LogTimestampTooltip.svelte';
	import TelemetryPrompt from '$lib/components/telemetry/TelemetryPrompt.svelte';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { env } from '$env/dynamic/public';
	import { initPostHog, identifyUser } from '$lib/posthog';
	import { captureUrlSecrets, rememberReturnTo, secretRoute } from '$lib/utils/url-secrets';
	import { loadLatestUpdate, unseenUpdate } from '$lib/stores/updates';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import { whenIdle } from '$lib/utils/idle';
	import { Lazy } from '$lib/utils/lazy.svelte';
	import GraftConfirmHost from '$lib/grafts/GraftConfirmHost.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import { isFullscreenGraftPath } from '$lib/grafts/registry';

	let { children } = $props();

	let loading = $state(true);
	let mainScrolled = $state(false);

	const updatesModal = new Lazy(() => import('$lib/components/UpdatesModal.svelte'));
	const UpdatesModal = $derived(updatesModal.current);
	$effect(() => {
		if (loading || !$user) return;
		untrack(() => loadLatestUpdate());
	});

	$effect(() => {
		if (loading || !$unseenUpdate) return;
		untrack(() => updatesModal.preload());
	});

	const palette = new Lazy(() => import('$lib/components/AppPalette.svelte'));
	const Palette = $derived(palette.current);
	let paletteRef = $state<{ openSearch: () => void } | null>(null);
	let stopPaletteBoot: (() => void) | null = null;

	async function bootPalette(): Promise<boolean> {
		const component = await palette.preload();
		if (!component) return false;
		stopPaletteBoot?.();
		stopPaletteBoot = null;
		await tick();
		return true;
	}

	function openPalette() {
		void bootPalette().then((ready) => {
			if (ready) paletteRef?.openSearch();
		});
	}

	onMount(() => {
		window.addEventListener('open-quick-search', openPalette);
		const unregister = registerShortcut({
			id: 'palette',
			key: 'k',
			mod: true,
			label: 'Search and actions',
			allowInInputs: true,
			run: openPalette
		});
		stopPaletteBoot = () => {
			window.removeEventListener('open-quick-search', openPalette);
			unregister();
		};
		const cancelIdle = whenIdle(() => bootPalette(), 5000);
		return () => {
			cancelIdle();
			stopPaletteBoot?.();
			stopPaletteBoot = null;
		};
	});

	function onMainScroll(e: Event) {
		const next = (e.currentTarget as HTMLElement).scrollTop > 4;
		if (next !== mainScrolled) mainScrolled = next;
	}

	// Don't check for pending invitations or redirect on these routes
	const skipRoutes = ['/invite', '/oauth/callback', '/setup', '/mcp/authorize'];

	function shouldSkipChecks(pathname: string): boolean {
		return skipRoutes.some((route) => pathname.startsWith(route));
	}

	// /setup/claim is reachable signed out by design: on an instance with no
	// email transport it is the only way to make the first account, so bouncing
	// it to the login page is a deadlock. The rest of /setup stays gated.
	const publicRoutes = [
		'/status',
		'/invite',
		'/oauth/callback',
		'/sso',
		'/mcp',
		'/cli',
		'/auth/protect',
		'/setup/claim'
	];

	// /<org>/login is the org's own SSO entry point and is meant to be reached
	// signed out, so it can't be bounced back to the platform login page.
	// It also paints before auth has bootstrapped: it is a signed-out page by
	// definition, and a tenant's branded login screen should not open on the
	// app's boot spinner.
	const isOrgLoginRoute = $derived($page.route.id === '/[orgSlug=orgSlug]/login');
	const isDevHarness = $derived(dev && ($page.route.id?.startsWith('/dev/') ?? false));

	function isPublicPath(pathname: string) {
		if (dev && pathname.startsWith('/dev/')) return true;
		if (pathname === '/' || publicRoutes.some((route) => pathname.startsWith(route))) return true;
		return /^\/[^/]+\/login\/?$/.test(pathname);
	}

	// After a deploy, the chunks a running tab knows about no longer exist
	// on the server, so client-side navigation loads nothing until a reload.
	// When a new build is detected, turn the next navigation into a full
	// page load so the tab picks up the new build transparently.
	beforeNavigate(({ willUnload, to }) => {
		if (!dev && $updated && !willUnload && to?.url) {
			location.href = to.url.href;
		}
	});

	// The guard above only helps tabs that navigate. Parked tabs (logs,
	// metrics) would run the stale build indefinitely — prompt them instead.
	let updatePromptShown = false;
	$effect(() => {
		if (!dev && $updated && !updatePromptShown) {
			updatePromptShown = true;
			toasts.add({
				title: 'Orchard was updated',
				description: 'Reload to get the latest version.',
				color: 'info',
				duration: 0,
				action: { label: 'Reload', onClick: () => location.reload() }
			});
		}
	});

	$effect(() => {
		if (loading || $isSignedIn) return;
		const path = $page.url.pathname;
		if (isPublicPath(path) || $page.route.id?.startsWith('/status')) return;
		// Anything under an org's own tree bounces to that org's login page
		// rather than the platform one, so an SSO-only tenant lands where it
		// can actually sign in. The route id is what matched, so this can't
		// misfire on /setup or /admin.
		if ($page.route.id?.startsWith('/[orgSlug=orgSlug]') && $page.params.orgSlug) {
			goto(`/${$page.params.orgSlug}/login`, { replaceState: true });
			return;
		}
		if (secretRoute(path)) rememberReturnTo(path);
		goto('/', { replaceState: true });
	});

	onMount(() => {
		if (!dev || !browser) return;
		let unmount: (() => void) | undefined;
		import('$lib/dev/ui-picker').then((m) => {
			unmount = m.mountUiPicker();
		});
		return () => unmount?.();
	});

	onMount(async () => {
		if (!browser) return;
		try {
			// Initialize theme as early as possible to prevent flash
			themeStore.init();

			captureUrlSecrets();

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

	const FULLSCREEN_PREFIXES = ['/setup', '/auth/protect', '/dev/ui'];
	const fullscreenPath = $derived(
		FULLSCREEN_PREFIXES.some((prefix) => $page.url.pathname.startsWith(prefix)) ||
			isFullscreenGraftPath($page.url.pathname)
	);

	$effect(() => {
		if ($isSignedIn) void graftHost.load();
	});
</script>

<svelte:head>
	<title>Orchard Dashboard</title>
	{#if secretRoute($page.url.pathname)}<meta name="referrer" content="no-referrer" />{/if}
</svelte:head>

<QueryClientProvider client={queryClient}>
	{#if loading && !isOrgLoginRoute && !isDevHarness}
		<div class="boot-splash">
			<div class="lds-ellipsis">
				<div></div>
				<div></div>
				<div></div>
				<div></div>
			</div>
		</div>
	{:else if $isSignedIn && !$signingIn && (fullscreenPath || $page.route.id?.startsWith('/status'))}
		{@render children()}
	{:else if $isSignedIn && !$signingIn}
		<div class="app-shell">
			<SidebarDeck />
			<div class="app-col">
				<MobileTopBar scrolled={mainScrolled} />
				<main class="app-main" onscroll={onMainScroll}>
					{@render children()}
				</main>
			</div>
		</div>
	{:else}
		<main class="min-h-screen">
			{@render children()}
		</main>
	{/if}

	<ToastContainer />
	<OnboardingModal />
	{#if !loading}
		<TelemetryPrompt />
		{#if UpdatesModal}
			<UpdatesModal />
		{/if}
	{/if}
	{#if Palette}
		<Palette bind:this={paletteRef} />
	{/if}
	<LogTimestampTooltip />
	<GraftConfirmHost />
</QueryClientProvider>

<style>
	.app-shell {
		display: flex;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
	}
	.app-col {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}
	.app-main {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior-y: contain;
	}

	.boot-splash {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		background-color: var(--bg-app);
	}
	.lds-ellipsis,
	.lds-ellipsis div {
		box-sizing: border-box;
	}
	.lds-ellipsis {
		position: relative;
		width: 80px;
		height: 80px;
		color: var(--accent);
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
		left: 9.33333px;
		animation: lds-ellipsis1 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(2) {
		left: 9.33333px;
		animation: lds-ellipsis2 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(3) {
		left: 33.33333px;
		animation: lds-ellipsis2 0.6s infinite;
	}
	.lds-ellipsis div:nth-child(4) {
		left: 57.33333px;
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
