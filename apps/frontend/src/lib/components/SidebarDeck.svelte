<script lang="ts">
	import { untrack } from 'svelte';
	import { Lazy } from '$lib/utils/lazy.svelte';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { env as publicEnv } from '$env/dynamic/public';
	import { greenhouseFlag, sandboxEnvOverride, sandboxesOn } from '$lib/flags';
	import { instanceFeatures } from '$lib/stores/instance-features';
	import GraftIcon from '$lib/grafts/GraftIcon.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import {
		Leaf,
		Zap,
		Trees,
		ChevronDown,
		ChevronRight,
		Palette,
		Mail,
		Moon,
		Monitor,
		PanelLeftClose,
		PanelLeftOpen,
		TriangleAlert,
		Search,
		Activity,
		Sprout,
		Settings,
		Shield,
		LogOut,
		KeyRound,
		Scale,
		SquareTerminal,
		Sun
	} from 'lucide-svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { StatusDot, resourceStatus, PopoverPanel, RemoteImg, Avatar } from '$lib/components/ui';
	import {
		springRotate,
		springCollapse,
		motionStagger,
		motionEnabled,
		transition
	} from '$lib/utils/motion.svelte';
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
	import { fade, fly } from '$lib/utils/transitions';

	interface OverviewDep {
		id: string;
		name: string;
		displayName?: string | null;
		status: string;
		buildStatus: string;
		faviconUrl?: string | null;
	}

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});

	const orgSlug = $derived($selectedOrganization?.slug ?? '');
	const canOpenOrgSettings = $derived(
		$selectedOrganization?.myRole === 'owner' || $selectedOrganization?.myRole === 'admin'
	);

	function selectOrg(org: Organization) {
		organizations.setSelected(org);
		goto(`/${org.slug}`);
	}

	type NavEntry = {
		id: string;
		label: string;
		href: string;
		icon: typeof Leaf | null;
		active: boolean;
		graftIcon?: { icon?: string; assetBase: string };
	};

	const nav: NavEntry[] = $derived([
		{
			id: 'apps',
			label: 'Your Apps',
			href: `/${orgSlug}`,
			icon: Leaf,
			active:
				$page.url.pathname === '/' + orgSlug ||
				$page.url.pathname.startsWith('/' + orgSlug + '/projects')
		},
		{
			id: 'jobs',
			label: 'Jobs',
			href: `/${orgSlug}/jobs`,
			icon: Zap,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/jobs')
		},
		{
			id: 'usage',
			label: 'Usage',
			href: `/${orgSlug}/usage`,
			icon: Activity,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/usage')
		},
		...($sandboxesOn && $greenhouseFlag
			? [
					{
						id: 'sandboxes',
						label: 'Greenhouse',
						href: '/sandboxes',
						icon: Sprout,
						active: $page.url.pathname.startsWith('/sandboxes')
					}
				]
			: []),
		...(publicEnv.PUBLIC_GROVE_ENABLED === 'true'
			? [
					{
						id: 'grove',
						label: 'The Grove',
						href: '/grove',
						icon: Trees,
						active: $page.url.pathname.startsWith('/grove')
					}
				]
			: []),
		...graftHost.slot('nav.primary').map(({ graftId, host, item }) => {
			const href = item.href.replaceAll('{org}', orgSlug ?? '');
			return {
				id: `graft:${graftId}:${item.id}`,
				label: item.label,
				href,
				icon: null,
				active: $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`),
				graftIcon: { icon: item.icon, assetBase: host.graft.assetBase }
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

	let attentionOpen = $state(false);

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
			...transition('smooth'),
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

	function onStripClick() {
		attentionOpen = !attentionOpen;
	}

	let themeMode = $state<ThemeMode>('auto');
	$effect(() => {
		if (browser) themeStore.init();
		const unsub = themeStore.subscribe((val) => (themeMode = val.mode));
		return unsub;
	});

	function applyQuickTheme(mode: 'light' | 'dark' | 'system') {
		themeStore.setMode(mode === 'system' ? 'auto' : mode);
	}

	function isThemeActive(mode: 'light' | 'dark' | 'system') {
		return themeMode === (mode === 'system' ? 'auto' : mode);
	}

	function navStagger(index: number, stride?: number) {
		return motionStagger({ index, stride, from: { y: 6 } });
	}

	function depName(pin: { name: string; live: OverviewDep | null }) {
		return pin.live?.displayName || pin.live?.name || pin.name;
	}

	const userName = $derived(
		$user?.firstName || $user?.lastName
			? `${$user?.firstName ?? ''} ${$user?.lastName ?? ''}`.trim()
			: $user?.name || $user?.username || 'You'
	);
	const invitationCount = $derived($pendingInvitations.length);

	$effect(() => {
		if ($isSuperAdmin) instanceChecklist.load();
	});

	$effect(() => {
		if (browser && sandboxEnvOverride() === null) void instanceFeatures.load();
	});
</script>

{#snippet orgAvatar(org: Organization | null, size: 'md' | 'sm')}
	<span class="deck-org-avatar" class:deck-org-avatar--sm={size === 'sm'}>
		{#if org?.avatarUrl}
			<RemoteImg src={org.avatarUrl} />
		{:else}
			{(org?.name ?? '?').charAt(0)}
		{/if}
	</span>
{/snippet}

{#snippet failingRow(dep: OverviewDep, i: number)}
	<a href="/{orgSlug}/deployments/{dep.id}" class="deck-attention-row" {@attach navStagger(i)}>
		<StatusDot meta={resourceStatus(dep.status, dep.buildStatus)} size={7} />
		<span class="deck-row-label">{dep.displayName || dep.name}</span>
	</a>
{/snippet}

{#snippet userAvatarEl()}
	<span class="deck-user-avatar">
		<Avatar user={$user} alive />
	</span>
{/snippet}

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
	class="sidebar deck-host"
	class:deck-host--collapsed={railed}
	class:deck-host--drawer={isMobile}
	class:deck-host--drawer-open={isMobile && $mobileNavOpen}
	inert={isMobile && !$mobileNavOpen}
>
	<div class="deck-panel">
		<PopoverPanel placement="bottom-start" sameWidth={!railed}>
			{#snippet trigger(attrs, open)}
				<button
					type="button"
					class="deck-org-trigger"
					class:deck-org-trigger--collapsed={railed}
					title={railed ? ($selectedOrganization?.name ?? 'Select org') : undefined}
					{...attrs}
				>
					{@render orgAvatar($selectedOrganization, 'md')}
					{#if !railed}
						<span class="deck-org-text">
							<span class="deck-org-name">{$selectedOrganization?.name ?? 'Select org'}</span>
							{#if $selectedOrganization?.plan}
								<span class="deck-org-plan">{$selectedOrganization.plan}</span>
							{/if}
						</span>
						<span {@attach springRotate(() => open, { rest: 0, on: 180 })}>
							<ChevronDown size={15} class="deck-org-chevron" />
						</span>
					{/if}
				</button>
			{/snippet}
			{#snippet children({ close })}
				<div class="deck-menu">
					{#each $organizations as org (org.id)}
						{#if org.id !== $selectedOrganization?.id}
							<button
								type="button"
								class="deck-menu-item"
								onclick={() => {
									selectOrg(org);
									close();
								}}
							>
								{@render orgAvatar(org, 'sm')}
								<span class="deck-org-row-name">{org.name}</span>
							</button>
						{/if}
					{/each}
					{#if canOpenOrgSettings}
						<a
							class="deck-menu-item deck-menu-item--muted"
							href={`/${orgSlug}/settings`}
							onclick={close}
						>
							<Settings size={14} />
							Organization settings
						</a>
					{/if}
				</div>
			{/snippet}
		</PopoverPanel>

		<button
			type="button"
			class="deck-search"
			class:deck-search--collapsed={railed}
			title={railed ? `Search (${isMac ? '⌘' : 'Ctrl+'}K)` : undefined}
			onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
		>
			<Search size={14} />
			{#if !railed}
				<span class="deck-search-label">Search</span>
				<kbd class="deck-kbd">{isMac ? '⌘' : 'Ctrl'}K</kbd>
			{/if}
		</button>

		{#if orgSlug}
			<div class="deck-scroll">
				{#if failingDeps.length > 0}
					{#if railed}
						<PopoverPanel placement="right-start">
							{#snippet trigger(attrs)}
								<button
									type="button"
									class="deck-strip deck-strip--collapsed"
									title="{failingDeps.length} failing"
									{...attrs}
								>
									<span class="deck-tile deck-tile--alert">
										<TriangleAlert size={15} />
										<span class="deck-tile-badge">{failingDeps.length}</span>
									</span>
								</button>
							{/snippet}
							{#snippet children({ close })}
								<div class="deck-menu deck-menu--attention">
									<p class="deck-menu-title">{failingDeps.length} failing</p>
									{#each failingDeps as dep, i (dep.id)}
										<a
											href="/{orgSlug}/deployments/{dep.id}"
											class="deck-attention-row"
											onclick={close}
											{@attach navStagger(i)}
										>
											<StatusDot meta={resourceStatus(dep.status, dep.buildStatus)} size={7} />
											<span class="deck-row-label">{dep.displayName || dep.name}</span>
										</a>
									{/each}
								</div>
							{/snippet}
						</PopoverPanel>
					{:else}
						<button
							type="button"
							class="deck-strip"
							aria-expanded={attentionOpen}
							onclick={onStripClick}
						>
							<span class="deck-tile deck-tile--alert">
								<TriangleAlert size={15} />
							</span>
							<span class="deck-row-label">Failing</span>
							<span class="deck-strip-count">{failingDeps.length}</span>
							<span
								class="deck-strip-chevron"
								{@attach springRotate(() => attentionOpen, { rest: 0, on: 90 })}
							>
								<ChevronRight size={13} />
							</span>
						</button>
						<div {@attach springCollapse(() => !attentionOpen)}>
							<div class="deck-strip-body">
								{#each failingDeps as dep, i (dep.id)}
									{@render failingRow(dep, i)}
								{/each}
							</div>
						</div>
					{/if}
					<div class="deck-gap"></div>
				{/if}

				<div class="deck-section-head">
					{#if !railed}
						<span>Platform</span>
					{/if}
				</div>
				{#each nav as item, i (item.id)}
					<a
						href={item.href}
						class="deck-row"
						class:deck-row--active={item.active}
						title={railed ? item.label : undefined}
						{@attach navStagger(i)}
					>
						<span class="deck-tile" class:deck-tile--active={item.active}>
							{#if item.icon}
								<item.icon size={15} />
							{:else if item.graftIcon}
								<GraftIcon icon={item.graftIcon.icon} assetBase={item.graftIcon.assetBase} />
							{/if}
						</span>
						{#if !railed}
							<span class="deck-row-label">{item.label}</span>
						{/if}
					</a>
				{/each}

				{#if pinnedDeps.length > 0}
					<div class="deck-section-head deck-section-head--spaced">
						{#if !railed}
							<span>Pinned</span>
						{/if}
					</div>
					{#each pinnedDeps as pin, i (pin.id)}
						<a
							href={pin.href}
							class="deck-row"
							title={railed ? depName(pin) : undefined}
							{@attach navStagger(nav.length + i)}
						>
							<span class="deck-tile deck-tile--fav">
								{#if pin.live?.faviconUrl}
									<RemoteImg src={pin.live.faviconUrl} />
								{:else}
									{depName(pin).charAt(0).toUpperCase()}
								{/if}
								{#if pin.live}
									<span class="deck-fav-dot">
										<StatusDot
											meta={resourceStatus(pin.live.status, pin.live.buildStatus)}
											size={6}
										/>
									</span>
								{/if}
							</span>
							{#if !railed}
								<span class="deck-row-label">{depName(pin)}</span>
							{/if}
						</a>
					{/each}
				{/if}
			</div>
		{/if}

		<div class="deck-spacer"></div>

		<div class="deck-split">
			<PopoverPanel placement="top-start">
				{#snippet trigger(attrs)}
					<button
						type="button"
						class="deck-split-id"
						class:deck-split-id--collapsed={railed}
						title={railed ? `@${$user?.username ?? 'you'}` : undefined}
						{...attrs}
					>
						{@render userAvatarEl()}
						{#if !railed}
							<span class="deck-user-name deck-user-name--mono">
								@{$user?.username ?? 'you'}
							</span>
							{#if invitationCount > 0}
								<span class="deck-user-badge">{invitationCount}</span>
							{/if}
						{/if}
						{#if $instanceChecklistWarnings.length > 0}
							<span class="deck-user-flag" title="This instance still needs setting up"></span>
						{/if}
					</button>
				{/snippet}
				{#snippet children({ close })}
					<div class="deck-menu">
						<div class="deck-theme-trio">
							<button
								type="button"
								class="deck-theme-btn"
								class:deck-theme-btn--active={isThemeActive('light')}
								aria-label="Light theme"
								onclick={() => applyQuickTheme('light')}
							>
								<Sun size={14} />
							</button>
							<button
								type="button"
								class="deck-theme-btn"
								class:deck-theme-btn--active={isThemeActive('dark')}
								aria-label="Dark theme"
								onclick={() => applyQuickTheme('dark')}
							>
								<Moon size={14} />
							</button>
							<button
								type="button"
								class="deck-theme-btn"
								class:deck-theme-btn--active={isThemeActive('system')}
								aria-label="System theme"
								onclick={() => applyQuickTheme('system')}
							>
								<Monitor size={14} />
							</button>
						</div>
						<div class="deck-menu-divider"></div>
						{#if invitationCount > 0}
							<a class="deck-menu-item" href="/user/settings?tab=profile" onclick={close}>
								<Mail size={14} />
								Invitations
								<span class="deck-user-badge">{invitationCount}</span>
							</a>
						{/if}
						{#if $isSuperAdmin}
							<a class="deck-menu-item" href="/admin" onclick={close}>
								<Shield size={14} />
								Instance admin
								{#if $instanceChecklistOutstanding.length > 0}
									<span class="deck-user-badge">{$instanceChecklistOutstanding.length}</span>
								{/if}
							</a>
						{/if}
						<a class="deck-menu-item" href="/user/settings" onclick={close}>
							<Settings size={14} />
							Settings
						</a>
						<button
							type="button"
							class="deck-menu-item"
							onclick={() => {
								close();
								cliOpen = true;
							}}
						>
							<SquareTerminal size={14} />
							Command line
						</button>
						<a class="deck-menu-item" href="/user/settings?tab=tokens" onclick={close}>
							<KeyRound size={14} />
							API tokens
						</a>
						<a class="deck-menu-item" href="/user/settings?tab=appearance" onclick={close}>
							<Palette size={14} />
							Theme
						</a>
						<a
							class="deck-menu-item"
							href="/third-party-notices.txt"
							target="_blank"
							rel="noopener"
							onclick={close}
						>
							<Scale size={14} />
							Open source licenses
						</a>
						<button
							type="button"
							class="deck-menu-item deck-menu-item--danger"
							onclick={() => user.signOut()}
						>
							<LogOut size={14} />
							Sign out
						</button>
					</div>
				{/snippet}
			</PopoverPanel>
			<button
				type="button"
				class="deck-split-action"
				class:deck-split-action--hidden={isMobile}
				aria-label={railed ? 'Expand sidebar' : 'Collapse sidebar'}
				title="{railed ? 'Expand' : 'Collapse'} sidebar ({isMac ? '⌘' : 'Ctrl+'}B)"
				onclick={toggleCollapsed}
			>
				{#if railed}
					<PanelLeftOpen size={15} />
				{:else}
					<PanelLeftClose size={15} />
				{/if}
			</button>
		</div>
	</div>
</aside>

{#if CliModal}
	<CliModal bind:open={cliOpen} />
{/if}

<style>
	.deck-host {
		--rail-t: 1;
		--rail-text: clamp(0, calc((var(--rail-t) - 0.45) * 4), 1);
		width: 17.5rem;
		flex-shrink: 0;
		padding: 0.75rem;
		border-right: none;
		background-color: transparent;
	}

	.deck-scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background-color: rgb(0 0 0 / 0.32);
		backdrop-filter: blur(2px);
	}
	.deck-host--drawer {
		background-color: var(--bg-app);
		background-image: var(--theme-grain, none), var(--theme-chrome-image, none);
		background-size: auto;
		background-repeat: repeat;
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 50;
		width: min(19rem, 84vw);
		padding: 0.75rem;
		transform: translate3d(-102%, 0, 0);
		transition: transform var(--dur-base) cubic-bezier(0.32, 0.72, 0, 1);
		will-change: transform;
	}
	.deck-host--drawer-open {
		transform: translate3d(0, 0, 0);
		box-shadow: 0 0 60px rgb(0 0 0 / 0.24);
	}
	@media (prefers-reduced-motion: reduce) {
		.deck-host--drawer {
			transition: none;
		}
	}
	.deck-host--collapsed .deck-panel {
		padding: 0.5rem;
	}

	.deck-host--collapsed .deck-org-trigger,
	.deck-host--collapsed .deck-search,
	.deck-host--collapsed .deck-strip,
	.deck-host--collapsed .deck-row,
	.deck-host--collapsed .deck-split-id,
	.deck-host--collapsed .deck-split-action {
		width: 2.75rem;
		height: 2.75rem;
		margin-inline: auto;
		padding: 0;
		gap: 0;
		flex: none;
		justify-content: center;
	}
	.deck-split-id {
		min-width: 2.5rem;
	}
	.deck-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-width: 0;
		border-radius: var(--radius-xl);
		border: none;
		background-color: var(--bg-raised);
		color: var(--text-default);
		box-shadow: var(--elev-1);
		padding: var(--space-2);
		overflow: hidden;
	}
	.deck-org-trigger {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		color: currentColor;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--dur-fast);
	}
	.deck-org-trigger:hover {
		background-color: var(--bg-hover);
	}
	.deck-org-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		overflow: hidden;
		flex-shrink: 0;
		font-weight: 700;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 22%, transparent),
			color-mix(in srgb, var(--accent) 8%, transparent)
		);
		color: var(--accent);
	}
	.deck-org-avatar :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.deck-org-avatar--sm {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-sm);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}
	.deck-org-text {
		opacity: var(--rail-text);
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.deck-org-name {
		font-size: var(--text-body);
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-org-plan {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		opacity: 0.5;
		margin-top: 0.0625rem;
	}
	:global(.deck-org-chevron) {
		opacity: calc(0.5 * var(--rail-text));
		flex-shrink: 0;
	}
	.deck-org-row-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		margin: var(--space-2) 0 var(--space-3);
		padding: 0 var(--space-3);
		border: none;
		border-radius: var(--radius-md);
		box-shadow: inset 0 0 0 1px var(--rule);
		background: var(--fill-quiet);
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		cursor: pointer;
		box-sizing: border-box;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.deck-search:hover {
		color: var(--text-default);
		background: var(--fill-soft);
	}
	.deck-search-label {
		opacity: var(--rail-text);
		flex: 1;
		text-align: left;
		white-space: nowrap;
	}
	.deck-kbd {
		opacity: var(--rail-text);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-family: var(--font-mono, monospace);
		padding: 0.125rem 0.25rem;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
		background-color: var(--fill-soft);
	}
	.deck-scroll {
		overflow-y: auto;
		min-height: 0;
	}
	.deck-gap {
		height: 0.75rem;
	}
	.deck-strip {
		display: flex;
		align-items: center;
		white-space: nowrap;
		gap: 0.5rem;
		width: 100%;
		height: 2.25rem;
		padding: 0 0.4375rem;
		margin: 0.125rem 0;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--dur-fast);
		box-sizing: border-box;
	}
	.deck-strip:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}

	.deck-strip--collapsed {
		color: var(--status-error);
	}
	.deck-strip-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		margin-left: auto;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--status-error-bg);
		color: var(--status-error);
		font-size: var(--text-caption);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.deck-menu--attention {
		min-width: 13rem;
	}
	.deck-menu-title {
		margin: 0 0 0.25rem;
		padding: 0 0.5rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--status-error);
	}
	.deck-strip-chevron {
		opacity: var(--rail-text);
		display: inline-flex;
		color: var(--text-faint);
	}
	.deck-strip-body {
		opacity: var(--rail-text);
		padding: 0 0 var(--space-1) 2.25rem;
	}
	.deck-attention-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		padding: 0 var(--space-2);
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		text-decoration: none;
		transition: background-color var(--dur-fast);
	}
	.deck-attention-row:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.deck-section-head {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 1.75rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-faint);
		padding: 0 var(--space-3);
		user-select: none;
	}
	.deck-section-head--spaced {
		margin-top: 1rem;
	}
	.deck-section-head::before {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: 1.25rem;
		height: 1px;
		background-color: currentColor;
		opacity: calc(0.6 * (1 - var(--rail-text)));
	}
	.deck-section-head > span {
		opacity: var(--rail-text);
	}
	.deck-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		padding: 0 0.4375rem;
		/* A clear 4px trough between rows so an active pill and a hovered
		   neighbour never touch — Apple's sidebars keep this breathing room. */
		margin: 0.125rem 0;
		border-radius: var(--radius-md);
		color: var(--text-muted);
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
		min-width: 0;
	}
	.deck-row:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.deck-row--active {
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.deck-tile {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: var(--radius-xs);
		flex-shrink: 0;
		position: relative;
		color: var(--text-muted);
		transition: color var(--dur-fast);
	}
	.deck-row:hover .deck-tile {
		color: var(--text-default);
	}
	.deck-tile--active,
	.deck-row--active:hover .deck-tile--active {
		color: var(--accent);
	}
	.deck-tile--alert {
		color: var(--status-error);
		overflow: visible;
	}
	.deck-tile-badge {
		position: absolute;
		top: -0.3125rem;
		right: -0.3125rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0.9375rem;
		height: 0.9375rem;
		padding: 0 0.25rem;
		border-radius: var(--radius-pill);
		background-color: var(--status-error);
		color: #fff;
		font-size: var(--text-micro);
		font-weight: 700;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		box-shadow: 0 0 0 2px var(--bg-raised);
	}
	.deck-tile--fav {
		overflow: visible;
		background: var(--fill-soft);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
	}
	.deck-tile--fav :global(img) {
		width: 100%;
		height: 100%;
		border-radius: var(--radius-sm);
		object-fit: cover;
	}
	.deck-fav-dot {
		position: absolute;
		bottom: -2px;
		right: -2px;
		display: flex;
		border-radius: var(--radius-pill);
	}
	.deck-row-label {
		opacity: var(--rail-text);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}
	.deck-spacer {
		flex: 1;
	}
	.deck-user-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-pill);
		overflow: hidden;
		flex-shrink: 0;
		font-weight: 700;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		background-color: color-mix(in srgb, currentColor 10%, transparent);
	}
	.deck-user-avatar :global(img),
	.deck-user-avatar :global(svg) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.deck-user-name {
		opacity: var(--rail-text);
		font-size: var(--text-footnote);
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-user-name--mono {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.deck-user-flag {
		position: absolute;
		top: 0.3rem;
		right: 0.3rem;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--status-warning);
		box-shadow: 0 0 0 2px var(--bg-app);
	}

	.deck-split-id {
		position: relative;
	}

	.deck-user-badge {
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}
	.deck-split {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-top: var(--space-2);
		box-shadow: inset 0 1px 0 var(--rule);
	}
	.deck-split-id {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		height: 2.5rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-md);
		background: none;
		color: currentColor;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--dur-fast);
	}
	.deck-split-id:hover {
		background-color: var(--fill-soft);
	}
	.deck-split-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		border: none;
		background: none;
		color: color-mix(in srgb, currentColor 65%, transparent);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}
	.deck-split-action:hover {
		background-color: color-mix(in srgb, currentColor 8%, transparent);
		color: currentColor;
	}
	.deck-split-action--hidden {
		display: none;
	}
	.deck-split-action--danger:hover {
		background-color: var(--status-error-bg);
		color: var(--status-error);
	}
	.deck-menu {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.deck-menu-divider {
		height: 1px;
		margin: 0.5rem 0.25rem;
		background-color: var(--border-default);
	}
	.deck-theme-trio {
		display: flex;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem 0.5rem;
	}
	.deck-theme-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}
	.deck-theme-btn:hover {
		background-color: var(--bg-hover);
		color: var(--text-default);
	}
	.deck-theme-btn--active {
		background-color: color-mix(in srgb, var(--accent) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent) 30%, transparent);
		color: var(--accent);
	}
	.deck-menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		text-align: left;
		text-decoration: none;
		transition: background-color var(--dur-fast);
	}
	.deck-menu-item:hover {
		background-color: var(--bg-hover);
	}
	.deck-menu-item--muted {
		opacity: 0.75;
	}
	.deck-menu-item--danger {
		color: var(--status-error);
	}
</style>
