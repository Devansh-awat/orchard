<script lang="ts">
	import { page } from '$app/stores';
	import { PanelLeftClose, PanelLeft, FolderKanban, Search, Leaf, Folder } from 'lucide-svelte';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import { isSignedIn, selectedOrganization, pendingInvitations } from '$lib/stores';

	let collapsed = $state(false);

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');
</script>

<aside class="sidebar transition-all duration-200" style="width: {collapsed ? '4.5rem' : '16.5rem'};">
	<div class="sidebar-inner">
		<div class="sidebar-team-bar">
			{#if collapsed}
				<div class="flex flex-col gap-2 items-center">
					<button
						onclick={() => collapsed = !collapsed}
						class="sidebar-action"
						aria-label="Expand sidebar"
					>
						<PanelLeft class="h-5 w-5" />
					</button>
					{#if $selectedOrganization}
						<a href="/{$selectedOrganization.slug}/settings" class="sidebar-org-avatar-link">
							{#if $selectedOrganization.avatarUrl}
								<img
									src={$selectedOrganization.avatarUrl}
									alt={$selectedOrganization.name}
									class="sidebar-org-avatar"
								/>
							{:else}
								<div class="sidebar-org-avatar-fallback">
									<FolderKanban class="h-4 w-4" />
								</div>
							{/if}
						</a>
					{/if}
					<button
						onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
						class="sidebar-action"
						aria-label="Search"
						title="Search ({shortcutKey}K)"
					>
						<Search class="h-5 w-5" />
					</button>
					<a
						href="/{$selectedOrganization?.slug ?? ''}"
						class="sidebar-logo-link"
						aria-label="Overview"
						title="Overview"
					>
						<img src="/logo/logoiconcolor.svg" alt="Orchard" class="h-7 w-7" />
					</a>
				</div>
			{:else}
				<div class="flex items-center gap-2">
					<div class="flex-1">
						<WorkspacesMenu />
					</div>
					<button
						onclick={() => collapsed = !collapsed}
						class="sidebar-action"
						aria-label="Collapse sidebar"
					>
						<PanelLeftClose class="h-5 w-5" />
					</button>
				</div>
			{/if}
		</div>

		{#if !collapsed}
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
			</div>
		{/if}

		<div class="flex-1"></div>

		<div class="sidebar-footer">
			{#if collapsed}
				<a href="/user/settings" class="sidebar-footer-avatar-link relative">
					<div class="sidebar-footer-avatar">
						<span class="text-sm font-medium">U</span>
					</div>
					{#if $pendingInvitations.length > 0}
						<span class="sidebar-notification-dot"></span>
					{/if}
				</a>
			{:else}
				<UserMenu />
			{/if}
		</div>
	</div>
</aside>
