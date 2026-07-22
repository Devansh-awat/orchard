<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { env as publicEnv } from '$env/dynamic/public';
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
		PanelLeftOpen
	} from 'lucide-svelte';
	import { Search, Activity, Settings, LogOut, KeyRound, Sun } from '@jis3r/icons';
	import { createQuery } from '@tanstack/svelte-query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { StatusDot, resourceStatus, PopoverPanel } from '$lib/components/ui';
	import {
		springHover as motionSpringHover,
		springRotate,
		springCollapse,
		decorativeMotion
	} from '$lib/utils/motion.svelte';
	import { animate } from 'motion';
	import {
		user,
		organizations,
		selectedOrganization,
		pinnedItems,
		pendingInvitations,
		type Organization
	} from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
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
		icon: typeof Leaf;
		active: boolean;
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
			: [])
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

	const EXPANDED_W = 280;
	const COLLAPSED_W = 88;
	const COLLAPSE_KEY = 'sidebar-collapsed';

	let collapsed = $state(browser && localStorage.getItem(COLLAPSE_KEY) === '1');
	let asideEl: HTMLElement | undefined = $state();
	let visible = $state(true);

	function toggleCollapsed() {
		collapsed = !collapsed;
		if (browser) localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
	}

	let widthInitialized = false;
	$effect(() => {
		const el = asideEl;
		const width = `${collapsed ? COLLAPSED_W : EXPANDED_W}px`;
		if (!el) return;
		if (!widthInitialized || !decorativeMotion()) {
			widthInitialized = true;
			el.style.width = width;
			return;
		}
		document.documentElement.dataset.sidebarAnimating = 'true';
		const done = () => {
			delete document.documentElement.dataset.sidebarAnimating;
		};
		animate(el, { width }, { type: 'spring', stiffness: 240, damping: 26, mass: 1 }).finished.then(
			done,
			done
		);
	});

	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== 'b') return;
		if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey) return;
		if (e.shiftKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		toggleCollapsed();
	}

	function onStripClick() {
		if (collapsed) {
			toggleCollapsed();
			attentionOpen = true;
		} else {
			attentionOpen = !attentionOpen;
		}
	}

	$effect(() => {
		if (!asideEl) return;
		const ro = new ResizeObserver(() => {
			visible = (asideEl?.getBoundingClientRect().width ?? 0) > 0;
		});
		ro.observe(asideEl);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!visible) return;
		if (typeof document !== 'undefined') {
			document.documentElement.style.setProperty(
				'--app-sidebar-w',
				`${collapsed ? COLLAPSED_W : EXPANDED_W}px`
			);
		}
	});

	let activeThemeId = $state<string | null>(null);
	$effect(() => {
		if (browser) themeStore.init();
		const unsub = themeStore.activeThemeId.subscribe((val) => (activeThemeId = val));
		return unsub;
	});

	function applyQuickTheme(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') themeStore.setSystemTheme();
		else if (mode === 'light') themeStore.setActiveTheme('light');
		else themeStore.setActiveTheme('dark');
	}

	function isThemeActive(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') return !activeThemeId;
		return activeThemeId === mode;
	}

	function navStagger(index: number, stride = 0.04) {
		return (el: Element) => {
			if (!decorativeMotion()) return;
			animate(
				el as HTMLElement,
				{ opacity: [0, 1], y: [6, 0] },
				{ type: 'spring', stiffness: 300, damping: 25, mass: 0.75, delay: index * stride }
			);
		};
	}

	function springHover(opts: { lift?: number } = {}) {
		return motionSpringHover({ lift: -1, forwardIconHover: true, ...opts });
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
</script>

{#snippet orgAvatar(org: Organization | null, size: 'md' | 'sm')}
	<span class="deck-org-avatar" class:deck-org-avatar--sm={size === 'sm'}>
		{#if org?.avatarUrl}
			<img src={org.avatarUrl} alt="" />
		{:else}
			{(org?.name ?? '?').charAt(0)}
		{/if}
	</span>
{/snippet}

{#snippet failingRow(dep: OverviewDep, i: number)}
	<a
		href="/{orgSlug}/deployments/{dep.id}"
		class="deck-attention-row"
		{@attach navStagger(i)}
		{@attach springHover()}
	>
		<StatusDot meta={resourceStatus(dep.status, dep.buildStatus)} size={7} />
		<span class="deck-row-label">{dep.displayName || dep.name}</span>
	</a>
{/snippet}

{#snippet userAvatarEl()}
	<span class="deck-user-avatar">
		{#if $user?.imageUrl}
			<img src={$user.imageUrl} alt="" />
		{:else}
			{userName.charAt(0)}
		{/if}
	</span>
{/snippet}

<svelte:window onkeydown={onWindowKeydown} />

<aside bind:this={asideEl} class="sidebar deck-host" class:deck-host--collapsed={collapsed}>
	<div class="deck-panel">
		<PopoverPanel placement="bottom-start" sameWidth={!collapsed}>
			{#snippet trigger(attrs, open)}
				<button
					type="button"
					class="deck-org-trigger"
					class:deck-org-trigger--collapsed={collapsed}
					title={collapsed ? ($selectedOrganization?.name ?? 'Select org') : undefined}
					{...attrs}
					{@attach springHover()}
				>
					{@render orgAvatar($selectedOrganization, 'md')}
					{#if !collapsed}
						<span class="deck-org-text" transition:fade={{ duration: 120 }}>
							<span class="deck-org-name">{$selectedOrganization?.name ?? 'Select org'}</span>
							{#if $selectedOrganization?.plan}
								<span class="deck-org-plan">{$selectedOrganization.plan}</span>
							{/if}
						</span>
						<span
							transition:fade={{ duration: 120 }}
							{@attach springRotate(() => open, { rest: 0, on: 180 })}
						>
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
			class:deck-search--collapsed={collapsed}
			title={collapsed ? `Search (${isMac ? '⌘' : 'Ctrl+'}K)` : undefined}
			onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
			{@attach springHover()}
		>
			<Search size={14} />
			{#if !collapsed}
				<span class="deck-search-label" transition:fade={{ duration: 120 }}>Search</span>
				<kbd class="deck-kbd" transition:fade={{ duration: 120 }}>{isMac ? '⌘' : 'Ctrl'}K</kbd>
			{/if}
		</button>

		{#if orgSlug}
			<div class="deck-scroll">
				{#if failingDeps.length > 0}
					<button
						type="button"
						class="deck-strip"
						aria-expanded={!collapsed && attentionOpen}
						title={collapsed ? `${failingDeps.length} failing` : undefined}
						onclick={onStripClick}
					>
						<span class="deck-strip-dot"></span>
						<span>{failingDeps.length}</span>
						{#if !collapsed}
							<span transition:fade={{ duration: 120 }}>failing</span>
							<span
								class="deck-strip-chevron"
								transition:fade={{ duration: 120 }}
								{@attach springRotate(() => attentionOpen, { rest: 0, on: 90 })}
							>
								<ChevronRight size={12} />
							</span>
						{/if}
					</button>
					<div {@attach springCollapse(() => !attentionOpen || collapsed)}>
						<div class="deck-strip-body">
							{#each failingDeps as dep, i (dep.id)}
								{@render failingRow(dep, i)}
							{/each}
						</div>
					</div>
					<div class="deck-gap"></div>
				{/if}

				<div class="deck-section-head" class:deck-section-head--collapsed={collapsed}>
					{#if !collapsed}
						<span transition:fade={{ duration: 120 }}>Platform</span>
					{/if}
				</div>
				{#each nav as item, i (item.id)}
					<a
						href={item.href}
						class="deck-row"
						class:deck-row--active={item.active}
						title={collapsed ? item.label : undefined}
						{@attach navStagger(i)}
						{@attach springHover()}
					>
						<span class="deck-tile" class:deck-tile--active={item.active}>
							<item.icon size={15} />
						</span>
						{#if !collapsed}
							<span class="deck-row-label" transition:fly={{ x: -6, duration: 160 }}>{item.label}</span>
						{/if}
					</a>
				{/each}

				{#if pinnedDeps.length > 0}
					<div
						class="deck-section-head deck-section-head--spaced"
						class:deck-section-head--collapsed={collapsed}
					>
						{#if !collapsed}
							<span transition:fade={{ duration: 120 }}>Pinned</span>
						{/if}
					</div>
					{#each pinnedDeps as pin, i (pin.id)}
						<a
							href={pin.href}
							class="deck-row"
							title={collapsed ? depName(pin) : undefined}
							{@attach navStagger(nav.length + i)}
							{@attach springHover()}
						>
							<span class="deck-tile deck-tile--fav">
								{#if pin.live?.faviconUrl}
									<img src={pin.live.faviconUrl} alt="" loading="lazy" />
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
							{#if !collapsed}
								<span class="deck-row-label" transition:fly={{ x: -6, duration: 160 }}>{depName(pin)}</span>
							{/if}
						</a>
					{/each}
				{/if}
			</div>
		{/if}

		<div class="deck-spacer"></div>

		<div class="deck-split" class:deck-split--collapsed={collapsed}>
			<PopoverPanel placement="top-start">
				{#snippet trigger(attrs)}
					<button
						type="button"
						class="deck-split-id"
						class:deck-split-id--collapsed={collapsed}
						title={collapsed ? `@${$user?.username ?? 'you'}` : undefined}
						{...attrs}
						{@attach springHover()}
					>
						{@render userAvatarEl()}
						{#if !collapsed}
							<span class="deck-user-name deck-user-name--mono" transition:fade={{ duration: 120 }}>
								@{$user?.username ?? 'you'}
							</span>
							{#if invitationCount > 0}
								<span class="deck-user-badge" transition:fade={{ duration: 120 }}>{invitationCount}</span>
							{/if}
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
							<a class="deck-menu-item" href="/user/settings#invitations" onclick={close}>
								<Mail size={14} />
								Invitations
								<span class="deck-user-badge">{invitationCount}</span>
							</a>
						{/if}
						<a class="deck-menu-item" href="/user/settings" onclick={close}>
							<Settings size={14} />
							Settings
						</a>
						<a class="deck-menu-item" href="/user/api-tokens" onclick={close}>
							<KeyRound size={14} />
							API tokens
						</a>
						<a class="deck-menu-item" href="/user/settings/theme" onclick={close}>
							<Palette size={14} />
							Theme
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
			{#if !collapsed}
				<a
					class="deck-split-action"
					href="/user/settings"
					aria-label="Your settings"
					title="Settings"
					transition:fade={{ duration: 140 }}
					{@attach springHover()}
				>
					<Settings size={15} />
				</a>
				<button
					type="button"
					class="deck-split-action deck-split-action--danger"
					aria-label="Sign out"
					title="Sign out"
					transition:fade={{ duration: 140 }}
					onclick={() => user.signOut()}
					{@attach springHover()}
				>
					<LogOut size={15} />
				</button>
			{/if}
			<button
				type="button"
				class="deck-split-action"
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				title="{collapsed ? 'Expand' : 'Collapse'} sidebar ({isMac ? '⌘' : 'Ctrl+'}B)"
				onclick={toggleCollapsed}
				{@attach springHover()}
			>
				{#if collapsed}
					<PanelLeftOpen size={15} />
				{:else}
					<PanelLeftClose size={15} />
				{/if}
			</button>
		</div>
	</div>
</aside>

<style>
	.deck-host {
		width: 17.5rem;
		flex-shrink: 0;
		padding: 0.75rem;
		border-right: none;
		background-color: var(--bg-app);
	}
	.deck-host--collapsed .deck-panel {
		padding: 0.5rem;
	}
	.deck-org-trigger--collapsed {
		padding: 0.25rem;
	}
	.deck-search--collapsed {
		padding: 0.5rem 0 0.5rem 1rem;
	}
	.deck-split--collapsed {
		flex-direction: column;
		gap: 0.375rem;
	}
	.deck-split-id--collapsed {
		flex: none;
		justify-content: center;
		padding: 0.25rem;
	}
	.deck-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		border-radius: 1rem;
		border: 1px solid var(--border-default);
		background-color: var(--bg-raised);
		color: var(--text-default);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.04),
			0 4px 16px rgb(0 0 0 / 0.03);
		padding: 0.75rem;
		overflow: hidden;
	}
	.deck-org-trigger {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.5rem;
		border: none;
		border-radius: 0.75rem;
		background: none;
		color: currentColor;
		cursor: pointer;
		text-align: left;
		transition: background-color 120ms;
	}
	.deck-org-trigger:hover {
		background-color: color-mix(in srgb, currentColor 7%, transparent);
	}
	.deck-org-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		overflow: hidden;
		flex-shrink: 0;
		font-weight: 700;
		font-size: 1rem;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 22%, transparent),
			color-mix(in srgb, var(--accent) 8%, transparent)
		);
		color: var(--accent);
	}
	.deck-org-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.deck-org-avatar--sm {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.45rem;
		font-size: 0.6875rem;
	}
	.deck-org-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.deck-org-name {
		font-size: 0.9375rem;
		font-weight: 650;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-org-plan {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		opacity: 0.5;
		margin-top: 0.0625rem;
	}
	:global(.deck-org-chevron) {
		opacity: 0.5;
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
		margin: 0.5rem 0 0.75rem;
		padding: 0.5rem 0.625rem;
		border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
		border-radius: 0.625rem;
		background: none;
		color: color-mix(in srgb, currentColor 60%, transparent);
		font-size: 0.8125rem;
		cursor: pointer;
		transition:
			color 120ms,
			border-color 120ms;
	}
	.deck-search:hover {
		color: currentColor;
		border-color: color-mix(in srgb, currentColor 25%, transparent);
	}
	.deck-search-label {
		flex: 1;
		text-align: left;
		white-space: nowrap;
	}
	.deck-kbd {
		font-size: 0.625rem;
		font-family: var(--font-mono, monospace);
		padding: 0.125rem 0.3rem;
		border-radius: 0.3rem;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
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
		padding: 0.375rem 0.5rem;
		border: none;
		border-radius: 0.5rem;
		background: none;
		color: var(--status-error);
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
		transition: background-color 120ms;
	}
	.deck-strip:hover {
		background-color: var(--status-error-bg);
	}
	.deck-strip-dot {
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background-color: var(--status-error);
		flex-shrink: 0;
	}
	.deck-strip-chevron {
		display: inline-flex;
		margin-left: auto;
		opacity: 0.7;
	}
	.deck-strip-body {
		padding: 0.125rem 0.25rem 0.25rem;
	}
	.deck-attention-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.375rem;
		border-radius: 0.45rem;
		color: color-mix(in srgb, currentColor 85%, transparent);
		text-decoration: none;
		transition: background-color 120ms;
	}
	.deck-attention-row:hover {
		background-color: color-mix(in srgb, currentColor 7%, transparent);
	}
	.deck-section-head {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 1.625rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		opacity: 0.45;
		padding: 0 0.5rem;
		user-select: none;
	}
	.deck-section-head--spaced {
		margin-top: 1rem;
	}
	.deck-section-head--collapsed::before {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: 1.25rem;
		height: 1px;
		background-color: currentColor;
		opacity: 0.6;
	}
	.deck-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem;
		margin: 0.125rem 0;
		border-radius: 0.625rem;
		color: color-mix(in srgb, currentColor 78%, transparent);
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color 120ms,
			color 120ms;
		min-width: 0;
	}
	.deck-row:hover {
		background-color: color-mix(in srgb, currentColor 7%, transparent);
		color: currentColor;
	}
	.deck-row--active {
		background-color: color-mix(in srgb, var(--accent) 10%, transparent);
		color: currentColor;
	}
	.deck-tile {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		position: relative;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
		transition:
			background-color 120ms,
			color 120ms;
	}
	.deck-tile--active {
		background-color: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}
	.deck-tile--fav {
		overflow: visible;
		font-size: 0.6875rem;
		font-weight: 700;
	}
	.deck-tile--fav img {
		width: 100%;
		height: 100%;
		border-radius: 0.5rem;
		object-fit: cover;
	}
	.deck-fav-dot {
		position: absolute;
		bottom: -2px;
		right: -2px;
		display: flex;
		border-radius: 999px;
	}
	.deck-row-label {
		font-size: 0.875rem;
		font-weight: 500;
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
		border-radius: 999px;
		overflow: hidden;
		flex-shrink: 0;
		font-weight: 700;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, currentColor 10%, transparent);
	}
	.deck-user-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.deck-user-name {
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-user-name--mono {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
	}
	.deck-user-badge {
		font-size: 0.625rem;
		font-weight: 650;
		line-height: 1;
		padding: 0.1875rem 0.375rem;
		border-radius: 999px;
		background-color: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}
	.deck-split {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.deck-split-id {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		padding: 0.375rem 0.5rem;
		border: none;
		border-radius: 0.625rem;
		background: none;
		color: currentColor;
		cursor: pointer;
		text-align: left;
		transition: background-color 120ms;
	}
	.deck-split-id:hover {
		background-color: color-mix(in srgb, currentColor 7%, transparent);
	}
	.deck-split-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.625rem;
		border: none;
		background: none;
		color: color-mix(in srgb, currentColor 65%, transparent);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		transition:
			background-color 120ms,
			color 120ms;
	}
	.deck-split-action:hover {
		background-color: color-mix(in srgb, currentColor 8%, transparent);
		color: currentColor;
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
		margin: 0.375rem 0.25rem;
		background-color: var(--border-default);
	}
	.deck-theme-trio {
		display: flex;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem 0.375rem;
	}
	.deck-theme-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		height: 1.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border-default);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		transition:
			background-color 120ms,
			color 120ms;
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
		padding: 0.4375rem 0.625rem;
		border: none;
		border-radius: 0.5rem;
		background: none;
		color: var(--text-default);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		text-align: left;
		text-decoration: none;
		transition: background-color 120ms;
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
