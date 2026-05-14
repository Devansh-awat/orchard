<script lang="ts">
	import { page } from '$app/stores';
	import { animate } from 'motion';
	import { Leaf, Folder, Shield, Globe, ScrollText } from 'lucide-svelte';
	import {
		PanelLeftClose,
		PanelRightClose,
		Search,
		Activity,
		ArrowLeft,
		Settings,
		Users,
		Key,
		Gauge
	} from '@jis3r/icons';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import { selectedOrganization, sidebarCollapsed } from '$lib/stores';

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');

	const orgSlug = $derived($selectedOrganization?.slug ?? '');
	const isEnterprise = $derived($selectedOrganization?.plan === 'enterprise');
	const isSettingsRoute = $derived($page.url.pathname.startsWith('/' + orgSlug + '/settings'));
	const settingsTab = $derived($page.url.searchParams.get('tab') || 'general');
	const isAuditLogsRoute = $derived($page.url.pathname.startsWith('/' + orgSlug + '/settings/audit-logs'));
	// Org overview has an `auto-fill` grid whose column count flips mid-spring
	// when the sidebar width swings ~192px, snapping every card to a new cell.
	// On just that page, fall back to the original short CSS width transition.
	const isHomeRoute = $derived($page.url.pathname === '/' + orgSlug);

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

	// Velocity-aware lift + forwards mouseenter to descendant @jis3r icons so
	// they auto-animate when the parent (button/row) is hovered, not only when
	// the cursor lands directly on the icon's hit area.
	function springHover(opts: { lift?: number; stiffness?: number; damping?: number } = {}) {
		const { lift = -1, stiffness = 380, damping = 22 } = opts;
		return (el: Element) => {
			const t = el as HTMLElement;
			const enter = () => {
				animate(t, { y: lift }, { type: 'spring', stiffness, damping });
				t.querySelectorAll('[role="img"]').forEach((icon) => {
					icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
				});
			};
			const leave = () => animate(t, { y: 0 }, { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
			const press = () => animate(t, { scale: 0.94 }, { type: 'spring', stiffness: 600, damping: 28 });
			const release = () => animate(t, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 18 });
			t.addEventListener('mouseenter', enter);
			t.addEventListener('mouseleave', leave);
			t.addEventListener('pointerdown', press);
			t.addEventListener('pointerup', release);
			t.addEventListener('pointerleave', release);
			return () => {
				t.removeEventListener('mouseenter', enter);
				t.removeEventListener('mouseleave', leave);
				t.removeEventListener('pointerdown', press);
				t.removeEventListener('pointerup', release);
				t.removeEventListener('pointerleave', release);
			};
		};
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
			{:else}
				{#if isSettingsRoute}
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
			{/if}
		</div>

		{#if isSettingsRoute}
			<!-- Settings sidebar -->
			{#if !$sidebarCollapsed}
				<div class="sidebar-nav-animated" {@attach navIn}>
					<div class="settings-sidebar-title">Organization Settings</div>
					<div class="sidebar-home-link">
						<a
							href="/{orgSlug}/settings?tab=general"
							class="tree-node-content"
							class:is-active={settingsTab === 'general'}
							{@attach navStagger(0)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #6b7280">
								<Settings size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">General</span>
						</a>
						<a
							href="/{orgSlug}/settings?tab=members"
							class="tree-node-content"
							class:is-active={settingsTab === 'members'}
							{@attach navStagger(1)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #3b82f6">
								<Users size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Members</span>
						</a>
						<a
							href="/{orgSlug}/settings?tab=database"
							class="tree-node-content"
							class:is-active={settingsTab === 'database'}
							{@attach navStagger(2)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #10b981">
								<Globe size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Database</span>
						</a>
						<a
							href="/{orgSlug}/settings?tab=backups"
							class="tree-node-content"
							class:is-active={settingsTab === 'backups'}
							{@attach navStagger(3)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #8b5cf6">
								<Shield size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Backups</span>
						</a>
						{#if isEnterprise}
							<a
								href="/{orgSlug}/settings?tab=sso"
								class="tree-node-content"
								class:is-active={settingsTab === 'sso'}
								{@attach navStagger(4)}
								{@attach springHover({ lift: -1 })}
							>
								<div class="tree-icon-badge" style="background-color: #ef4444">
									<Key size={10} class="tree-icon-svg" />
								</div>
								<span class="tree-node-label">SSO</span>
							</a>
						{/if}
						<a
							href="/{orgSlug}/settings/audit-logs"
							class="tree-node-content"
							class:is-active={isAuditLogsRoute}
							{@attach navStagger(5)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #475569">
								<ScrollText size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Audit Log</span>
						</a>
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
					<a
						href="/{orgSlug}/settings?tab=general"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'general'}
						aria-label="General"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #6b7280">
							<Settings size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">General</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=members"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'members'}
						aria-label="Members"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #3b82f6">
							<Users size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Members</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=database"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'database'}
						aria-label="Database"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #10b981">
							<Globe size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Database</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=backups"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'backups'}
						aria-label="Backups"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #8b5cf6">
							<Shield size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Backups</span>
					</a>
					{#if isEnterprise}
						<a
							href="/{orgSlug}/settings?tab=sso"
							class="sidebar-collapsed-icon"
							class:is-active={settingsTab === 'sso'}
							aria-label="SSO"
							{@attach springHover()}
						>
							<div class="tree-icon-badge" style="background-color: #ef4444">
								<Key size={11} class="tree-icon-svg" />
							</div>
							<span class="sidebar-collapsed-tooltip">SSO</span>
						</a>
					{/if}
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
					<div class="sidebar-home-link">
						<a
							href="/{orgSlug}"
							class="tree-node-content"
							class:is-active={$page.url.pathname === '/' + orgSlug}
							{@attach navStagger(0)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #22c55e">
								<Leaf size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Overview</span>
						</a>
						<a
							href="/{orgSlug}/projects"
							class="tree-node-content"
							class:is-active={$page.url.pathname.startsWith('/' + orgSlug + '/projects')}
							{@attach navStagger(1)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #4a8aff">
								<Folder size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Projects</span>
						</a>
						<a
							href="/{orgSlug}/usage"
							class="tree-node-content"
							class:is-active={$page.url.pathname.startsWith('/' + orgSlug + '/usage')}
							{@attach navStagger(2)}
							{@attach springHover({ lift: -1 })}
						>
							<div class="tree-icon-badge" style="background-color: #f59e0b">
								<Activity size={10} class="tree-icon-svg" />
							</div>
							<span class="tree-node-label">Usage</span>
						</a>
					</div>
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
						<span class="sidebar-collapsed-tooltip">Search <kbd class="sidebar-collapsed-tooltip-kbd">{shortcutKey}K</kbd></span>
					</button>
					<a
						href="/{orgSlug}"
						class="sidebar-collapsed-icon"
						class:is-active={$page.url.pathname === '/' + orgSlug}
						aria-label="Overview"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #22c55e">
							<Leaf size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Overview</span>
					</a>
					<a
						href="/{orgSlug}/projects"
						class="sidebar-collapsed-icon"
						class:is-active={$page.url.pathname.startsWith('/' + orgSlug + '/projects')}
						aria-label="Projects"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #4a8aff">
							<Folder size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Projects</span>
					</a>
					<a
						href="/{orgSlug}/usage"
						class="sidebar-collapsed-icon"
						class:is-active={$page.url.pathname.startsWith('/' + orgSlug + '/usage')}
						aria-label="Usage"
						{@attach springHover()}
					>
						<div class="tree-icon-badge" style="background-color: #f59e0b">
							<Activity size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Usage</span>
					</a>
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
		transition: opacity 120ms ease, background-color 120ms ease;
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
</style>
