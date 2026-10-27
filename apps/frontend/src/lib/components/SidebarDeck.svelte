<script lang="ts">
	import { untrack } from 'svelte';
	import { Lazy } from '$lib/utils/lazy.svelte';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { graftHost } from '$lib/grafts/host.svelte';
	import {
		Sprout,
		Timer,
		Gauge,
		Puzzle,
		Mail,
		Moon,
		Monitor,
		Settings,
		Shield,
		LogOut,
		KeyRound,
		Scale,
		SquareTerminal,
		Sun,
		Palette
	} from 'lucide-svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { resourceStatus, Avatar } from '$lib/components/ui';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import type { SidebarSection } from '$lib/components/patterns/sidebar';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import { motionEnabled, transition } from '$lib/utils/motion.svelte';
	import { animate } from 'motion';
	import {
		user,
		isSuperAdmin,
		instanceChecklist,
		instanceChecklistOutstanding,
		instanceChecklistWarnings,
		organizations,
		selectedOrganization,
		pinnedItems,
		pendingInvitations,
		mobileNavOpen,
		sidebarWidthPx,
		SIDEBAR_EXPANDED_W,
		SIDEBAR_COLLAPSED_W,
		MOBILE_NAV_QUERY,
		type Organization
	} from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import type { ThemeMode } from '$lib/theme/spec';
	import { fade } from '$lib/utils/transitions';

	interface OverviewDep {
		id: string;
		name: string;
		displayName?: string | null;
		status: string;
		buildStatus: string;
		faviconUrl?: string | null;
	}

	const orgSlug = $derived($selectedOrganization?.slug ?? '');
	const canOpenOrgSettings = $derived(
		$selectedOrganization?.myRole === 'owner' || $selectedOrganization?.myRole === 'admin'
	);

	function selectOrg(org: Organization) {
		organizations.setSelected(org);
		goto(`/${org.slug}`);
	}

	const nav = $derived([
		{
			id: 'apps',
			label: 'Your Apps',
			href: `/${orgSlug}`,
			icon: Sprout,
			active:
				$page.url.pathname === '/' + orgSlug ||
				$page.url.pathname.startsWith('/' + orgSlug + '/projects')
		},
		{
			id: 'jobs',
			label: 'Jobs',
			href: `/${orgSlug}/jobs`,
			icon: Timer,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/jobs')
		},
		{
			id: 'usage',
			label: 'Usage',
			href: `/${orgSlug}/usage`,
			icon: Gauge,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/usage')
		},
		...graftHost.slot('nav.primary').map(({ graftId, item }) => {
			const href = item.href.replaceAll('{org}', orgSlug ?? '');
			return {
				id: `graft:${graftId}:${item.id}`,
				label: item.label,
				href,
				icon: Puzzle,
				active: $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`)
			};
		})
	]);

	const overviewQuery = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug,
		refetchInterval: 45000,
		staleTime: 15000
	}));

	const orgDeps: OverviewDep[] = $derived(overviewQuery.data?.deployments ?? []);
	const failingDeps = $derived(
		orgDeps.filter((d) => resourceStatus(d.status, d.buildStatus).kind === 'error').slice(0, 4)
	);
	const pinnedDeps = $derived.by(() => {
		const byId = new Map(orgDeps.map((d) => [d.id, d]));
		return $pinnedItems
			.filter((i) => i.type === 'deployment')
			.slice(0, 6)
			.map((i) => ({ ...i, live: byId.get(i.id) ?? null }));
	});

	const EXPANDED_W = SIDEBAR_EXPANDED_W;
	const COLLAPSED_W = SIDEBAR_COLLAPSED_W;
	const RAIL_SWAP_T = 0.45;
	const COLLAPSE_KEY = 'sidebar-collapsed';

	let collapsed = $state(browser && localStorage.getItem(COLLAPSE_KEY) === '1');
	let asideEl: HTMLElement | undefined = $state();
	let isMobile = $state(false);
	let railed = $state(browser && localStorage.getItem(COLLAPSE_KEY) === '1');
	let cliOpen = $state(false);
	const cliModal = new Lazy(() => import('./CliModal.svelte'));
	const CliModal = $derived(cliModal.current);

	$effect(() => {
		if (cliOpen) untrack(() => cliModal.preload());
	});

	$effect(() => {
		const path = $page.url.pathname;
		if (path) mobileNavOpen.close();
	});

	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia(MOBILE_NAV_QUERY);
		const sync = () => {
			isMobile = mq.matches;
			if (!mq.matches) mobileNavOpen.close();
		};
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	$effect(() => {
		if (!browser) return;
		const locked = isMobile && $mobileNavOpen;
		document.body.style.overflow = locked ? 'hidden' : '';
		return () => {
			document.body.style.overflow = '';
		};
	});

	function toggleCollapsed() {
		collapsed = !collapsed;
		if (browser) localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
	}

	function publishWidth(px: number) {
		document.documentElement.style.setProperty('--app-sidebar-w', `${px}px`);
	}

	let widthInitialized = false;
	$effect(() => {
		const el = asideEl;
		const mobile = isMobile;
		const target = collapsed;
		if (!el) return;
		if (mobile) {
			el.style.width = '';
			widthInitialized = false;
			railed = false;
			publishWidth(0);
			return;
		}
		const toW = sidebarWidthPx(target, false);
		if (!widthInitialized || !motionEnabled()) {
			widthInitialized = true;
			el.style.width = `${toW}px`;
			el.style.setProperty('--rail-t', target ? '0' : '1');
			railed = target;
			publishWidth(toW);
			return;
		}
		const fromW = el.getBoundingClientRect().width || toW;
		document.documentElement.dataset.sidebarAnimating = 'true';
		const done = () => {
			delete document.documentElement.dataset.sidebarAnimating;
			publishWidth(toW);
		};
		animate(fromW, toW, {
			...transition('snap', { distance: Math.abs(toW - fromW) }),
			onUpdate: (v) => {
				el.style.width = `${v}px`;
				publishWidth(v);
				const t = Math.max(0, Math.min(1, (v - COLLAPSED_W) / (EXPANDED_W - COLLAPSED_W)));
				el.style.setProperty('--rail-t', String(t));
				const wantRail = t <= RAIL_SWAP_T;
				if (wantRail !== railed) railed = wantRail;
			}
		}).finished.then(done, done);
	});

	$effect(() => () => {
		if (browser) document.documentElement.style.removeProperty('--app-sidebar-w');
	});

	$effect(() =>
		registerShortcut({
			id: 'sidebar',
			key: 'b',
			mod: true,
			label: 'Toggle sidebar',
			run: toggleCollapsed
		})
	);

	let themeMode = $state<ThemeMode>('auto');
	$effect(() => {
		if (browser) themeStore.init();
		const unsub = themeStore.subscribe((val) => (themeMode = val.mode));
		return unsub;
	});

	const sections = $derived<SidebarSection[]>(
		orgSlug
			? [
					...(failingDeps.length
						? [
								{
									label: 'Failing',
									tiles: true,
									items: failingDeps.map((d) => ({
										label: d.displayName || d.name,
										href: `/${orgSlug}/deployments/${d.id}`,
										status: resourceStatus(d.status, d.buildStatus)
									}))
								}
							]
						: []),
					{
						label: 'Platform',
						items: nav.map((n) => ({
							label: n.label,
							href: n.href,
							icon: n.icon,
							active: n.active
						}))
					},
					...(pinnedDeps.length
						? [
								{
									label: 'Pinned',
									tiles: true,
									items: pinnedDeps.map((p) => ({
										label: depName(p),
										href: p.href,
										status: p.live ? resourceStatus(p.live.status, p.live.buildStatus) : undefined
									}))
								}
							]
						: [])
				]
			: []
	);

	function applyQuickTheme(mode: 'light' | 'dark' | 'system') {
		themeStore.setMode(mode === 'system' ? 'auto' : mode);
	}

	function isThemeActive(mode: 'light' | 'dark' | 'system') {
		return themeMode === (mode === 'system' ? 'auto' : mode);
	}

	function depName(pin: { name: string; live: OverviewDep | null }) {
		return pin.live?.displayName || pin.live?.name || pin.name;
	}

	const invitationCount = $derived($pendingInvitations.length);

	$effect(() => {
		if ($isSuperAdmin) instanceChecklist.load();
	});
</script>

{#if isMobile && $mobileNavOpen}
	<div
		class="deck-scrim"
		role="presentation"
		onclick={() => mobileNavOpen.close()}
		transition:fade={{ duration: 160 }}
	></div>
{/if}

<aside
	bind:this={asideEl}
	class="deck-host"
	class:deck-host--drawer={isMobile}
	class:deck-host--drawer-open={isMobile && $mobileNavOpen}
	inert={isMobile && !$mobileNavOpen}
>
	<Sidebar
		org={{
			name: $selectedOrganization?.name ?? 'Select org',
			plan: $selectedOrganization?.plan,
			avatar: $selectedOrganization?.avatarUrl ?? null
		}}
		user={{ handle: $user?.username ?? 'you' }}
		{sections}
		collapsed={railed && !isMobile}
		onToggle={toggleCollapsed}
		onSearch={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
		userBadge={invitationCount + ($instanceChecklistWarnings.length > 0 ? 1 : 0)}
	>
		{#snippet orgMenu()}
			{#if $organizations.length > 1}
				<MenuLabel>Switch organization</MenuLabel>
				{#each $organizations as org (org.id)}
					<MenuItem checked={org.id === $selectedOrganization?.id} onclick={() => selectOrg(org)}
						>{org.name}</MenuItem
					>
				{/each}
				<MenuSeparator />
			{/if}
			{#if canOpenOrgSettings}
				<MenuItem icon={Settings} href="/{orgSlug}/settings">Organization settings</MenuItem>
			{/if}
		{/snippet}
		{#snippet userAvatar()}<Avatar user={$user} alive />{/snippet}
		{#snippet userMenu()}
			<MenuLabel>Theme</MenuLabel>
			<MenuItem icon={Sun} checked={isThemeActive('light')} onclick={() => applyQuickTheme('light')}
				>Light</MenuItem
			>
			<MenuItem icon={Moon} checked={isThemeActive('dark')} onclick={() => applyQuickTheme('dark')}
				>Dark</MenuItem
			>
			<MenuItem
				icon={Monitor}
				checked={isThemeActive('system')}
				onclick={() => applyQuickTheme('system')}>System</MenuItem
			>
			<MenuSeparator />
			{#if invitationCount > 0}
				<MenuItem icon={Mail} href="/user/settings?tab=profile"
					>Invitations ({invitationCount})</MenuItem
				>
			{/if}
			{#if $isSuperAdmin}
				<MenuItem icon={Shield} href="/admin">
					Instance admin{$instanceChecklistOutstanding.length
						? ` (${$instanceChecklistOutstanding.length})`
						: ''}
				</MenuItem>
			{/if}
			<MenuItem icon={Settings} href="/user/settings">Settings</MenuItem>
			<MenuItem icon={SquareTerminal} onclick={() => (cliOpen = true)}>Command line</MenuItem>
			<MenuItem icon={KeyRound} href="/user/settings?tab=tokens">API tokens</MenuItem>
			<MenuItem icon={Palette} href="/user/settings?tab=appearance">Appearance</MenuItem>
			<MenuItem icon={Scale} href="/third-party-notices.txt" target="_blank" rel="noopener"
				>Open source licenses</MenuItem
			>
			<MenuSeparator />
			<MenuItem icon={LogOut} danger onclick={() => user.signOut()}>Sign out</MenuItem>
		{/snippet}
	</Sidebar>
</aside>
{#if CliModal}
	<CliModal bind:open={cliOpen} />
{/if}

<style>
	.deck-host {
		position: relative;
		z-index: var(--z-nav);
		width: 17.25rem;
		height: 100%;
		flex-shrink: 0;
		padding: 0.625rem;
	}
	.deck-scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background-color: color-mix(in oklab, var(--neutral-10) 40%, transparent);
	}
	.deck-host--drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 50;
		width: min(18rem, 84vw);
		transform: translate3d(-102%, 0, 0);
		transition: transform var(--spring-snap-duration) var(--spring-snap);
		will-change: transform;
	}
	.deck-host--drawer-open {
		transform: none;
	}
	.deck-host--drawer :global(.panel) {
		background: var(--bg-raised);
	}
	.deck-host--drawer :global(.fold) {
		display: none;
	}
</style>
