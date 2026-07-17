<script lang="ts">
	import { page } from '$app/stores';
	import { env as publicEnv } from '$env/dynamic/public';
	import { animate } from 'motion';
	import { Leaf, Shield, Globe, ScrollText, Bell, Zap, Trees, TriangleAlert } from 'lucide-svelte';
	import {
		PanelLeftClose,
		PanelRightClose,
		Search,
		Activity,
		ArrowLeft,
		Settings,
		Users,
		Key,
		UserCog,
		Gauge
	} from '@jis3r/icons';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { StatusDot, resourceStatus } from '$lib/components/ui';
	import {
		springHover as motionSpringHover,
		decorativeMotion,
		functionalMotion
	} from '$lib/utils/motion.svelte';
	import { selectedOrganization, sidebarCollapsed, pinnedItems } from '$lib/stores';
	import { featureFlag } from '$lib/posthog';

	interface OverviewDep {
		id: string;
		name: string;
		status: string;
		buildStatus: string;
	}

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');

	const orgSlug = $derived($selectedOrganization?.slug ?? '');
	const isEnterprise = $derived($selectedOrganization?.plan === 'enterprise');
	const notificationsEnabled = featureFlag('notifications');
	const isSettingsRoute = $derived($page.url.pathname.startsWith('/' + orgSlug + '/settings'));
	const settingsTab = $derived($page.url.searchParams.get('tab') || 'general');
	const isAuditLogsRoute = $derived(
		$page.url.pathname.startsWith('/' + orgSlug + '/settings/audit-logs')
	);
	// Org overview has an `auto-fill` grid whose column count flips mid-spring
	// when the sidebar width swings ~192px, snapping every card to a new cell.
	// On just that page, fall back to the original short CSS width transition.
	const isHomeRoute = $derived($page.url.pathname === '/' + orgSlug);

	type NavEntry = {
		label: string;
		href: string;
		icon: typeof Settings;
		active: boolean;
	};

	const platformNav: NavEntry[] = $derived([
		{
			label: 'Your Apps',
			href: `/${orgSlug}`,
			icon: Leaf,
			active:
				$page.url.pathname === '/' + orgSlug ||
				$page.url.pathname.startsWith('/' + orgSlug + '/projects')
		},
		{
			label: 'Jobs',
			href: `/${orgSlug}/jobs`,
			icon: Zap,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/jobs')
		},
		{
			label: 'Usage',
			href: `/${orgSlug}/usage`,
			icon: Activity,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/usage')
		}
	]);

	const communityNav: NavEntry[] = $derived(
		publicEnv.PUBLIC_GROVE_ENABLED === 'true'
			? [
					{
						label: 'The Grove',
						href: '/grove',
						icon: Trees,
						active: $page.url.pathname.startsWith('/grove')
					}
				]
			: []
	);

	const mainNav: NavEntry[] = $derived([...platformNav, ...communityNav]);

	const overviewQuery = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug && !isSettingsRoute,
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

	const settingsNav: NavEntry[] = $derived.by(() => {
		const tabs = [
			{ label: 'General', tab: 'general', icon: Settings },
			{ label: 'Members', tab: 'members', icon: Users },
			{ label: 'Database', tab: 'database', icon: Globe },
			{ label: 'Backups', tab: 'backups', icon: Shield },
			...($notificationsEnabled
				? [{ label: 'Notifications', tab: 'notifications', icon: Bell }]
				: []),
			...(isEnterprise
				? [
						{ label: 'SSO', tab: 'sso', icon: Key },
						{ label: 'SCIM', tab: 'scim', icon: UserCog }
					]
				: [])
		];
		return [
			...tabs.map((t) => ({
				label: t.label,
				href: `/${orgSlug}/settings?tab=${t.tab}`,
				icon: t.icon,
				active: settingsTab === t.tab && !isAuditLogsRoute
			})),
			{
				label: 'Audit Log',
				href: `/${orgSlug}/settings/audit-logs`,
				icon: ScrollText,
				active: isAuditLogsRoute
			}
		];
	});

	const COLLAPSED_W = '4.5rem';
	const EXPANDED_W = '16.5rem';

	let asideEl: HTMLElement | undefined = $state();
	let prevCollapsed = $sidebarCollapsed;
	let didInitWidth = false;

	// Bouncy spring on the aside width. Motion owns the inline `width` — no
	// reactive `style="width: ..."` binding, otherwise Svelte would snap the
	// width on toggle (clobbering the spring) and the instant layout shift
	// would flicker every card in the sibling main content.
	//
	// While the spring is in flight we set `data-sidebar-animating` on <html>.
	// CSS in app.css uses that to disable pointer-events + box-shadow
	// transitions on `<main>` for the duration, which kills the cascade of
	// hover-state flickers that fire as cards shift under the cursor.
	// Toggle `data-sidebar-animating` on <html> for the duration of any width
	// change (spring OR CSS transition). Tracks how many animations are in
	// flight so back-to-back toggles don't drop the flag early. app.css uses
	// the attribute to disable hover springs + box-shadow transitions on
	// <main>, killing the flicker cascade as cards shift under the cursor.
	let animatingDepth = 0;
	function setAnimating(on: boolean) {
		if (typeof document === 'undefined') return;
		if (on) {
			animatingDepth++;
			document.documentElement.dataset.sidebarAnimating = 'true';
		} else {
			animatingDepth = Math.max(0, animatingDepth - 1);
			if (animatingDepth === 0) delete document.documentElement.dataset.sidebarAnimating;
		}
	}

	$effect(() => {
		const collapsed = $sidebarCollapsed;
		const home = isHomeRoute;
		// Expose the sidebar width so overlays (modals) can center within the
		// content area instead of the whole viewport.
		if (typeof document !== 'undefined') {
			document.documentElement.style.setProperty(
				'--app-sidebar-w',
				collapsed ? COLLAPSED_W : EXPANDED_W
			);
		}
		if (!asideEl) return;
		if (!didInitWidth) {
			asideEl.style.width = collapsed ? COLLAPSED_W : EXPANDED_W;
			didInitWidth = true;
			prevCollapsed = collapsed;
			return;
		}
		if (collapsed === prevCollapsed) return;
		prevCollapsed = collapsed;
		if (!functionalMotion()) {
			asideEl.style.width = collapsed ? COLLAPSED_W : EXPANDED_W;
			return;
		}
		if (home) {
			// Plain CSS transition — see .sidebar--css-transition rule. We pair
			// transitionend with a safety timeout matching the CSS duration.
			setAnimating(true);
			asideEl.style.width = collapsed ? COLLAPSED_W : EXPANDED_W;
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				setAnimating(false);
				asideEl?.removeEventListener('transitionend', onEnd);
			};
			const onEnd = (e: TransitionEvent) => {
				if (e.propertyName === 'width') finish();
			};
			asideEl.addEventListener('transitionend', onEnd);
			setTimeout(finish, 450);
			return;
		}
		setAnimating(true);
		animate(
			asideEl,
			{ width: collapsed ? COLLAPSED_W : EXPANDED_W },
			{ type: 'spring', stiffness: 420, damping: 20, mass: 0.85 }
		).finished.then(
			() => setAnimating(false),
			() => setAnimating(false)
		);
	});

	// Mount-time stagger for nav items. Replaces CSS keyframes so timing is
	// physics-driven and consistent with the project page.
	function navStagger(index: number, stride = 0.035) {
		return (el: Element) => {
			if (!decorativeMotion()) return;
			const target = el as HTMLElement;
			animate(
				target,
				{ opacity: [0, 1], x: [-8, 0] },
				{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7, delay: index * stride }
			);
		};
	}

	// IN spring for the nav container. Pairs with svelte out:fade for the exit
	// (a snappier, cheaper close — user is done with it, get out of the way).
	function navIn(el: Element) {
		if (!decorativeMotion()) return;
		const target = el as HTMLElement;
		animate(
			target,
			{ opacity: [0, 1], x: [-10, 0] },
			{ type: 'spring', stiffness: 300, damping: 28, mass: 0.85 }
		);
	}

	function springHover(opts: { lift?: number; stiffness?: number; damping?: number } = {}) {
		return motionSpringHover({ lift: -1, forwardIconHover: true, ...opts });
	}

	// One-shot pop whenever the collapsed state flips — gives the toggle button
	// a satisfying "click landed" feedback that matches the panel motion.
	function togglePop(el: Element) {
		const target = el as HTMLElement;
		let prev = $sidebarCollapsed;
		$effect(() => {
			const next = $sidebarCollapsed;
			if (next !== prev && decorativeMotion()) {
				animate(
					target,
					{ scale: [0.82, 1.08, 1], rotate: [next ? 8 : -8, 0] },
					{ type: 'spring', stiffness: 480, damping: 16, mass: 0.9 }
				);
			}
			prev = next;
		});
	}
</script>

{#snippet navItem(item: NavEntry, index: number)}
	<a
		href={item.href}
		class="tree-node-content"
		class:is-active={item.active}
		{@attach navStagger(index)}
		{@attach springHover({ lift: -1 })}
	>
		<item.icon size={15} class="tree-icon" />
		<span class="tree-node-label">{item.label}</span>
	</a>
{/snippet}

{#snippet navItemCollapsed(item: NavEntry)}
	<a
		href={item.href}
		class="sidebar-collapsed-icon"
		class:is-active={item.active}
		aria-label={item.label}
		{@attach springHover()}
	>
		<item.icon size={17} class="tree-icon" />
		<span class="sidebar-collapsed-tooltip">{item.label}</span>
	</a>
{/snippet}

<aside bind:this={asideEl} class="sidebar" class:sidebar--css-transition={isHomeRoute}>
	<div class="sidebar-inner">
		<div class="sidebar-team-bar" class:is-collapsed={$sidebarCollapsed}>
			{#if $sidebarCollapsed}
				<div class="flex flex-col gap-1.5 items-center">
					<button
						onclick={() => sidebarCollapsed.toggle()}
						class="sidebar-action"
						aria-label="Expand sidebar"
						{@attach springHover()}
						{@attach togglePop}
					>
						<PanelRightClose size={20} />
					</button>
					{#if !isSettingsRoute}
						<WorkspacesMenu collapsed />
					{/if}
				</div>
			{:else if isSettingsRoute}
				<div class="flex items-center gap-2">
					<a href="/{orgSlug}" class="settings-back-btn" {@attach springHover({ lift: -1 })}>
						<ArrowLeft size={16} />
						<span>Back</span>
					</a>
					<div class="flex-1"></div>
					<button
						onclick={() => sidebarCollapsed.toggle()}
						class="sidebar-action"
						aria-label="Collapse sidebar"
						{@attach springHover()}
						{@attach togglePop}
					>
						<PanelLeftClose size={20} />
					</button>
				</div>
			{:else}
				<div class="flex items-center gap-2">
					<div class="flex-1">
						<WorkspacesMenu />
					</div>
					<button
						onclick={() => sidebarCollapsed.toggle()}
						class="sidebar-action"
						aria-label="Collapse sidebar"
						{@attach springHover()}
						{@attach togglePop}
					>
						<PanelLeftClose size={20} />
					</button>
				</div>
			{/if}
		</div>

		{#if isSettingsRoute}
			<!-- Settings sidebar -->
			{#if !$sidebarCollapsed}
				<div class="sidebar-nav-animated" {@attach navIn}>
					<div class="settings-sidebar-title">Organization Settings</div>
					<div class="sidebar-home-link">
						{#each settingsNav as item, i (item.href)}
							{@render navItem(item, i)}
						{/each}
					</div>
				</div>
			{:else}
				<div class="sidebar-collapsed-nav" {@attach navIn}>
					<a
						href="/{orgSlug}"
						class="sidebar-collapsed-icon"
						aria-label="Back"
						{@attach springHover()}
					>
						<ArrowLeft size={18} />
						<span class="sidebar-collapsed-tooltip">Back</span>
					</a>
					{#each settingsNav as item (item.href)}
						{@render navItemCollapsed(item)}
					{/each}
				</div>
			{/if}
		{:else}
			<!-- Normal sidebar -->
			{#if !$sidebarCollapsed}
				<div class="sidebar-nav-animated" {@attach navIn}>
					<div class="sidebar-search-area">
						<button
							type="button"
							onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
							class="sidebar-search-trigger"
							{@attach springHover({ lift: -1 })}
						>
							<div class="sidebar-search-icon-wrapper">
								<Search size={14} />
							</div>
							<span class="sidebar-search-placeholder">Search</span>
							<kbd class="sidebar-search-kbd">{isMac ? '⌘' : 'Ctrl'}K</kbd>
						</button>
					</div>
					<!-- Without a selected org the slug is empty and these hrefs would
					     render as "//projects" — a protocol-relative external URL. -->
					{#if orgSlug}
						<div class="sidebar-home-link">
							{#if failingDeps.length > 0}
								<div class="sidebar-section-label sidebar-attention-label">
									Needs attention
									<span class="sidebar-attention-count">{failingDeps.length}</span>
								</div>
								{#each failingDeps as dep, i (dep.id)}
									<a
										href="/{orgSlug}/deployments/{dep.id}"
										class="tree-node-content sidebar-dep-row"
										{@attach navStagger(i)}
										{@attach springHover({ lift: -1 })}
									>
										<StatusDot meta={resourceStatus(dep.status, dep.buildStatus)} size={7} />
										<span class="tree-node-label">{dep.name}</span>
									</a>
								{/each}
							{/if}
							<div
								class="sidebar-section-label"
								class:sidebar-section-label--spaced={failingDeps.length > 0}
							>
								Platform
							</div>
							{#each platformNav as item, i (item.href)}
								{@render navItem(item, i)}
							{/each}
							{#if pinnedDeps.length > 0}
								<div class="sidebar-section-label sidebar-section-label--spaced">Pinned</div>
								{#each pinnedDeps as pin, i (pin.id)}
									<a
										href={pin.href}
										class="tree-node-content sidebar-dep-row"
										{@attach navStagger(platformNav.length + i)}
										{@attach springHover({ lift: -1 })}
									>
										{#if pin.live}
											<StatusDot
												meta={resourceStatus(pin.live.status, pin.live.buildStatus)}
												size={7}
											/>
										{:else}
											<span class="sidebar-pin-dot"></span>
										{/if}
										<span class="tree-node-label">{pin.name}</span>
									</a>
								{/each}
							{/if}
							{#if communityNav.length > 0}
								<div class="sidebar-section-label sidebar-section-label--spaced">Community</div>
								{#each communityNav as item, i (item.href)}
									{@render navItem(item, platformNav.length + pinnedDeps.length + i)}
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div class="sidebar-collapsed-nav" {@attach navIn}>
					<button
						type="button"
						onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
						class="sidebar-collapsed-icon sidebar-collapsed-icon--search"
						aria-label="Search"
						{@attach springHover()}
					>
						<div class="sidebar-search-icon-wrapper">
							<Search size={16} />
						</div>
						<span class="sidebar-collapsed-tooltip"
							>Search <kbd class="sidebar-collapsed-tooltip-kbd">{shortcutKey}K</kbd></span
						>
					</button>
					{#if orgSlug}
						{#if failingDeps.length > 0}
							<a
								href="/{orgSlug}/deployments/{failingDeps[0].id}"
								class="sidebar-collapsed-icon sidebar-collapsed-icon--alert"
								aria-label="{failingDeps.length} failing"
								{@attach springHover()}
							>
								<TriangleAlert size={16} />
								<span class="sidebar-collapsed-alert-count">{failingDeps.length}</span>
								<span class="sidebar-collapsed-tooltip"
									>{failingDeps.length} failing deployment{failingDeps.length === 1
										? ''
										: 's'}</span
								>
							</a>
						{/if}
						{#each mainNav as item (item.href)}
							{@render navItemCollapsed(item)}
						{/each}
					{/if}
				</div>
			{/if}
		{/if}

		<div class="flex-1"></div>

		<div class="sidebar-footer" class:is-collapsed={$sidebarCollapsed}>
			<UserMenu collapsed={$sidebarCollapsed} />
		</div>
	</div>
</aside>

<style>
	.settings-back-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--sidebar-text);
		opacity: 0.7;
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		transition:
			opacity 120ms ease,
			background-color 120ms ease;
		text-decoration: none;
	}
	.settings-back-btn:hover {
		opacity: 1;
		background-color: var(--sidebar-text-hover-bg);
	}

	.settings-sidebar-title {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sidebar-text);
		opacity: 0.45;
		padding: 1rem 1rem 0.375rem;
	}

	.sidebar-nav-animated {
		display: flex;
		flex-direction: column;
	}

	/* Home-route fallback: the org overview grid flickers under the long
	   bouncy spring. Use the original short CSS transition there. */
	.sidebar--css-transition {
		transition: width 200ms ease;
	}
	/* Settings/org section tree items (moved from app.css) */
	.sidebar-section-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sidebar-text);
		opacity: 0.4;
		padding: 0.375rem 0.625rem 0.25rem;
		user-select: none;
	}

	.sidebar-section-label--spaced {
		padding-top: 1rem;
	}

	.sidebar-attention-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		opacity: 1;
		color: var(--status-error);
	}

	.sidebar-attention-count {
		font-size: 0.625rem;
		line-height: 1;
		padding: 0.1875rem 0.375rem;
		border-radius: 999px;
		background: var(--status-error-bg);
		border: 1px solid var(--status-error-border);
	}

	.sidebar-dep-row {
		gap: 9px;
		padding-left: 11px;
	}

	.sidebar-pin-dot {
		width: 7px;
		height: 7px;
		border-radius: 999px;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--sidebar-text) 30%, transparent);
	}

	:global(.sidebar-collapsed-icon--alert) {
		color: var(--status-error);
	}

	.sidebar-collapsed-alert-count {
		position: absolute;
		top: -0.125rem;
		right: -0.125rem;
		font-size: 0.5625rem;
		line-height: 1;
		font-weight: 600;
		padding: 0.125rem 0.25rem;
		border-radius: 999px;
		color: var(--status-error);
		background: var(--status-error-bg);
		border: 1px solid var(--status-error-border);
	}

	.tree-node-content {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		margin: 1px 0;
		border-radius: 0.375rem;
		cursor: pointer;
		color: color-mix(in srgb, var(--sidebar-text) 75%, transparent);
		transition:
			background-color 120ms ease,
			color 120ms ease;
		min-width: 0;
	}

	.tree-node-content:hover {
		background-color: var(--sidebar-text-hover-bg);
		color: var(--sidebar-text);
	}

	.tree-node-content.is-active {
		background-color: var(--sidebar-text-active-bg);
		color: var(--sidebar-text-active-color);
	}

	.tree-node-content :global(.tree-icon) {
		flex-shrink: 0;
		opacity: 0.55;
		transition: opacity 120ms ease;
	}

	.tree-node-content:hover :global(.tree-icon) {
		opacity: 0.8;
	}

	.tree-node-content.is-active :global(.tree-icon) {
		opacity: 1;
	}

	.tree-node-label {
		font-size: 0.8125rem;
		font-weight: 500;
		user-select: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		line-height: 1.3;
	}

	:global(.sidebar-collapsed-icon .tree-icon) {
		opacity: 0.55;
		transition: opacity 120ms ease;
	}

	:global(.sidebar-collapsed-icon:hover .tree-icon) {
		opacity: 0.8;
	}

	:global(.sidebar-collapsed-icon.is-active) {
		background-color: var(--sidebar-text-active-bg);
	}

	:global(.sidebar-collapsed-icon.is-active .tree-icon) {
		opacity: 1;
	}
</style>
