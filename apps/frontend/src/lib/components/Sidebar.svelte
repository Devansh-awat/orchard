<script lang="ts">
	import { page } from '$app/stores';
	import { animate } from 'motion';
	import { Leaf, Shield, Globe, ScrollText, Bell, Zap } from 'lucide-svelte';
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
	import { springHover as motionSpringHover } from '$lib/utils/motion.svelte';
	import { selectedOrganization, sidebarCollapsed } from '$lib/stores';
	import { featureFlag } from '$lib/posthog';

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

	const mainNav: NavEntry[] = $derived([
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
			if (next !== prev) {
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
							{#each mainNav as item, i (item.href)}
								{@render navItem(item, i)}
							{/each}
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
	.tree-node-content {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		margin: 1px 0;
		border-radius: 0.5rem;
		cursor: pointer;
		transition: background-color 120ms ease;
		min-width: 0;
	}

	.tree-node-content:hover {
		background-color: var(--sidebar-text-hover-bg);
	}

	.tree-node-content.is-active {
		background-color: var(--sidebar-text-active-bg);
		color: var(--sidebar-text-active-color);
	}

	.tree-node-content :global(.tree-icon) {
		flex-shrink: 0;
		opacity: 0.65;
		transition:
			opacity 120ms ease,
			color 120ms ease;
	}

	.tree-node-content:hover :global(.tree-icon) {
		opacity: 0.9;
	}

	.tree-node-content.is-active :global(.tree-icon) {
		opacity: 1;
		color: var(--accent);
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

	.tree-node-content.is-active .tree-node-label {
		font-weight: 600;
	}

	:global(.sidebar-collapsed-icon .tree-icon) {
		opacity: 0.65;
		transition:
			opacity 120ms ease,
			color 120ms ease;
	}

	:global(.sidebar-collapsed-icon:hover .tree-icon) {
		opacity: 0.9;
	}

	:global(.sidebar-collapsed-icon.is-active .tree-icon) {
		opacity: 1;
		color: var(--accent);
	}
</style>
