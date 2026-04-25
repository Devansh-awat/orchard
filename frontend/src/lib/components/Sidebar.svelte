<script lang="ts">
	import { page } from '$app/stores';
	import { fly, fade } from 'svelte/transition';
	import { PanelLeftClose, PanelLeft, Search, Leaf, Folder, Activity, ArrowLeft, Settings, Users, Shield, Globe, Key, Gauge } from 'lucide-svelte';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import { selectedOrganization, sidebarCollapsed } from '$lib/stores';

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');

	const orgSlug = $derived($selectedOrganization?.slug ?? '');
	const isSettingsRoute = $derived($page.url.pathname.startsWith('/' + orgSlug + '/settings'));
	const settingsTab = $derived($page.url.searchParams.get('tab') || 'general');
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
					{#if !isSettingsRoute}
						<WorkspacesMenu collapsed />
					{/if}
				</div>
			{:else}
				{#if isSettingsRoute}
					<div class="flex items-center gap-2">
						<a href="/{orgSlug}" class="settings-back-btn">
							<ArrowLeft class="h-4 w-4" />
							<span>Back</span>
						</a>
						<div class="flex-1"></div>
						<button
							onclick={() => sidebarCollapsed.toggle()}
							class="sidebar-action"
							aria-label="Collapse sidebar"
						>
							<PanelLeftClose class="h-5 w-5" />
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
						>
							<PanelLeftClose class="h-5 w-5" />
						</button>
					</div>
				{/if}
			{/if}
		</div>

		{#if isSettingsRoute}
			<!-- Settings sidebar -->
			{#if !$sidebarCollapsed}
				<div class="sidebar-nav-animated" in:fly={{ x: -12, duration: 180, delay: 80 }} out:fade={{ duration: 100 }}>
				<div class="settings-sidebar-title">Organization Settings</div>
				<div class="sidebar-home-link">
					<a
						href="/{orgSlug}/settings?tab=general"
						class="tree-node-content"
						class:is-active={settingsTab === 'general'}
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
					>
						<div class="tree-icon-badge" style="background-color: #3b82f6">
							<Users size={10} class="tree-icon-svg" />
						</div>
						<span class="tree-node-label">Members</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=quotas"
						class="tree-node-content"
						class:is-active={settingsTab === 'quotas'}
					>
						<div class="tree-icon-badge" style="background-color: #f59e0b">
							<Gauge size={10} class="tree-icon-svg" />
						</div>
						<span class="tree-node-label">Resource Quotas</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=database"
						class="tree-node-content"
						class:is-active={settingsTab === 'database'}
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
					>
						<div class="tree-icon-badge" style="background-color: #8b5cf6">
							<Shield size={10} class="tree-icon-svg" />
						</div>
						<span class="tree-node-label">Backups</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=sso"
						class="tree-node-content"
						class:is-active={settingsTab === 'sso'}
					>
						<div class="tree-icon-badge" style="background-color: #ef4444">
							<Key size={10} class="tree-icon-svg" />
						</div>
						<span class="tree-node-label">SSO</span>
					</a>
				</div>
				</div>
			{:else}
				<div class="sidebar-collapsed-nav">
					<a
						href="/{orgSlug}"
						class="sidebar-collapsed-icon"
						aria-label="Back"
					>
						<ArrowLeft class="h-[18px] w-[18px]" />
						<span class="sidebar-collapsed-tooltip">Back</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=general"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'general'}
						aria-label="General"
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
					>
						<div class="tree-icon-badge" style="background-color: #3b82f6">
							<Users size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Members</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=quotas"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'quotas'}
						aria-label="Resource Quotas"
					>
						<div class="tree-icon-badge" style="background-color: #f59e0b">
							<Gauge size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Quotas</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=database"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'database'}
						aria-label="Database"
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
					>
						<div class="tree-icon-badge" style="background-color: #8b5cf6">
							<Shield size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">Backups</span>
					</a>
					<a
						href="/{orgSlug}/settings?tab=sso"
						class="sidebar-collapsed-icon"
						class:is-active={settingsTab === 'sso'}
						aria-label="SSO"
					>
						<div class="tree-icon-badge" style="background-color: #ef4444">
							<Key size={11} class="tree-icon-svg" />
						</div>
						<span class="sidebar-collapsed-tooltip">SSO</span>
					</a>
				</div>
			{/if}
		{:else}
			<!-- Normal sidebar -->
			{#if !$sidebarCollapsed}
				<div class="sidebar-nav-animated" in:fly={{ x: -12, duration: 180, delay: 80 }} out:fade={{ duration: 100 }}>
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
						href="/{orgSlug}"
						class="tree-node-content"
						class:is-active={$page.url.pathname === '/' + orgSlug}
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
					>
						<div class="tree-icon-badge" style="background-color: #f59e0b">
							<Activity size={10} class="tree-icon-svg" />
						</div>
						<span class="tree-node-label">Usage</span>
					</a>
				</div>
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
						href="/{orgSlug}"
						class="sidebar-collapsed-icon"
						class:is-active={$page.url.pathname === '/' + orgSlug}
						aria-label="Overview"
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

	/* Stagger nav items on enter */
	.sidebar-nav-animated :global(.tree-node-content) {
		animation: sidebar-item-in 200ms ease both;
	}
	.sidebar-nav-animated :global(.tree-node-content:nth-child(1)) { animation-delay: 30ms; }
	.sidebar-nav-animated :global(.tree-node-content:nth-child(2)) { animation-delay: 60ms; }
	.sidebar-nav-animated :global(.tree-node-content:nth-child(3)) { animation-delay: 90ms; }
	.sidebar-nav-animated :global(.tree-node-content:nth-child(4)) { animation-delay: 120ms; }
	.sidebar-nav-animated :global(.tree-node-content:nth-child(5)) { animation-delay: 150ms; }
	.sidebar-nav-animated :global(.tree-node-content:nth-child(6)) { animation-delay: 180ms; }

	@keyframes sidebar-item-in {
		from {
			opacity: 0;
			transform: translateX(-6px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
