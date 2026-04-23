<script lang="ts">
	import { page } from '$app/stores';
	import { PanelLeftClose, PanelLeft, Search, Leaf, Folder, Activity } from 'lucide-svelte';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import { selectedOrganization, sidebarCollapsed } from '$lib/stores';

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');
</script>

<aside class="sidebar transition-all duration-200" style="width: {$sidebarCollapsed ? '4.5rem' : '16.5rem'};">
	<div class="sidebar-inner">
		<div class="sidebar-team-bar" class:is-collapsed={$sidebarCollapsed}>
			{#if $sidebarCollapsed}
				<div class="flex flex-col gap-1.5 items-center">
					<button
						onclick={() => sidebarCollapsed.toggle()}
						class="sidebar-action"
						aria-label="Expand sidebar"
					>
						<PanelLeft class="h-5 w-5" />
					</button>
					<WorkspacesMenu collapsed />
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
					>
						<PanelLeftClose class="h-5 w-5" />
					</button>
				</div>
			{/if}
		</div>

		{#if !$sidebarCollapsed}
			<div class="sidebar-search-area">
				<button
					type="button"
					onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
					class="sidebar-search-trigger"
				>
					<div class="sidebar-search-icon-wrapper">
						<Search class="h-3.5 w-3.5" />
					</div>
					<span class="sidebar-search-placeholder">Search</span>
					<kbd class="sidebar-search-kbd">{isMac ? '⌘' : 'Ctrl'}K</kbd>
				</button>
			</div>
			<div class="sidebar-home-link">
				<a
					href="/{$selectedOrganization?.slug ?? ''}"
					class="tree-node-content"
					class:is-active={$page.url.pathname === '/' + ($selectedOrganization?.slug ?? '')}
				>
					<div class="tree-icon-badge" style="background-color: #22c55e">
						<Leaf size={10} class="tree-icon-svg" />
					</div>
					<span class="tree-node-label">Overview</span>
				</a>
				<a
					href="/{$selectedOrganization?.slug ?? ''}/projects"
					class="tree-node-content"
					class:is-active={$page.url.pathname.startsWith('/' + ($selectedOrganization?.slug ?? '') + '/projects')}
				>
					<div class="tree-icon-badge" style="background-color: #4a8aff">
						<Folder size={10} class="tree-icon-svg" />
					</div>
					<span class="tree-node-label">Projects</span>
				</a>
				<a
					href="/{$selectedOrganization?.slug ?? ''}/usage"
					class="tree-node-content"
					class:is-active={$page.url.pathname.startsWith('/' + ($selectedOrganization?.slug ?? '') + '/usage')}
				>
					<div class="tree-icon-badge" style="background-color: #f59e0b">
						<Activity size={10} class="tree-icon-svg" />
					</div>
					<span class="tree-node-label">Usage</span>
				</a>
			</div>
		{:else}
			<div class="sidebar-collapsed-nav">
				<button
					type="button"
					onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
					class="sidebar-collapsed-icon"
					aria-label="Search"
				>
					<Search class="h-[18px] w-[18px]" />
					<span class="sidebar-collapsed-tooltip">Search <kbd class="sidebar-collapsed-tooltip-kbd">{shortcutKey}K</kbd></span>
				</button>
				<a
					href="/{$selectedOrganization?.slug ?? ''}"
					class="sidebar-collapsed-icon"
					class:is-active={$page.url.pathname === '/' + ($selectedOrganization?.slug ?? '')}
					aria-label="Overview"
				>
					<div class="tree-icon-badge" style="background-color: #22c55e">
						<Leaf size={11} class="tree-icon-svg" />
					</div>
					<span class="sidebar-collapsed-tooltip">Overview</span>
				</a>
				<a
					href="/{$selectedOrganization?.slug ?? ''}/projects"
					class="sidebar-collapsed-icon"
					class:is-active={$page.url.pathname.startsWith('/' + ($selectedOrganization?.slug ?? '') + '/projects')}
					aria-label="Projects"
				>
					<div class="tree-icon-badge" style="background-color: #4a8aff">
						<Folder size={11} class="tree-icon-svg" />
					</div>
					<span class="sidebar-collapsed-tooltip">Projects</span>
				</a>
				<a
					href="/{$selectedOrganization?.slug ?? ''}/usage"
					class="sidebar-collapsed-icon"
					class:is-active={$page.url.pathname.startsWith('/' + ($selectedOrganization?.slug ?? '') + '/usage')}
					aria-label="Usage"
				>
					<div class="tree-icon-badge" style="background-color: #f59e0b">
						<Activity size={11} class="tree-icon-svg" />
					</div>
					<span class="sidebar-collapsed-tooltip">Usage</span>
				</a>
			</div>
		{/if}

		<div class="flex-1"></div>

		<div class="sidebar-footer" class:is-collapsed={$sidebarCollapsed}>
			<UserMenu collapsed={$sidebarCollapsed} />
		</div>
	</div>
</aside>
