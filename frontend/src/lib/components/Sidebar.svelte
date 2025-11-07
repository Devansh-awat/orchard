<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { Tree } from 'melt/builders';
	import { PanelLeftClose, PanelLeft, FolderKanban, Package, Rocket, Loader2, ArrowUpRight, Search } from 'lucide-svelte';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import QuickSearch from './QuickSearch.svelte';
	import { tree, treeLoading, treeError, type TreeItem, isSignedIn, selectedOrganization } from '$lib/stores';
	import { slide } from 'svelte/transition';

	let quickSearchRef: QuickSearch;

	let collapsed = $state(false);
	let selectedId = $state<string | undefined>(undefined);
	let expandedIds = $state<Set<string>>(new Set());

	const isMac = $derived.by(() => {
		if (typeof window === 'undefined') return false;
		return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	});
	const shortcutKey = $derived(isMac ? '⌘' : 'Ctrl');

	let treeItems: TreeItem[] = $derived($tree as TreeItem[]);

	const treeBuilder = $derived.by(() => {
		return new Tree({
			items: treeItems,
			selected: selectedId,
			onSelectedChange: (value) => {
				selectedId = value;
			},
			expanded: () => expandedIds,
			onExpandedChange: (value) => {
				expandedIds = new Set(value);
			},
			expandOnClick: false
		});
	});

	function handleItemKeydown(
		event: KeyboardEvent,
		node: TreeItem | undefined,
		item: (typeof treeBuilder.children)[number],
		hasChildren: boolean
	) {
		if (event.key === ' ' && hasChildren) {
			event.preventDefault();
			event.stopPropagation();
			item.toggleExpand();
			return;
		}
		if (event.key === 'Enter' && node?.href) {
			event.preventDefault();
			event.stopPropagation();
			selectedId = item.id;
			goto(node.href);
		}
	}

	function findItemById(items: TreeItem[], id: string): TreeItem | null {
		for (const item of items) {
			if (item.id === id) {
				return item;
			}
			if (item.children) {
				const found = findItemById(item.children, id);
				if (found) return found;
			}
		}
		return null;
	}

	function getIcon(type: TreeItem['type']) {
		switch (type) {
			case 'workspace':
				return FolderKanban;
			case 'project':
				return Package;
			case 'deployment':
				return Rocket;
			default:
				return FolderKanban;
		}
	}

	function isActive(href: string) {
		return $page.url.pathname === href || $page.url.pathname.startsWith(href + '/');
	}


	$effect(() => {
		const findActiveItem = (items: TreeItem[]): TreeItem | null => {
			for (const item of items) {
				if (isActive(item.href)) {
					return item;
				}
				if (item.children) {
					const found = findActiveItem(item.children);
					if (found) return found;
				}
			}
			return null;
		};

		const activeItem = findActiveItem(treeItems);
		if (activeItem) {
			selectedId = activeItem.id;
			treeBuilder.expand(activeItem.id);
			if (activeItem.type === 'deployment') {
				const parentProject = findParentProject(treeItems, activeItem.id);
				if (parentProject) {
					treeBuilder.expand(parentProject.id);
					const parentWorkspace = findParentWorkspace(treeItems, parentProject.id);
					if (parentWorkspace) {
						treeBuilder.expand(parentWorkspace.id);
					}
				}
			} else if (activeItem.type === 'project') {
				const parentWorkspace = findParentWorkspace(treeItems, activeItem.id);
				if (parentWorkspace) {
					treeBuilder.expand(parentWorkspace.id);
				}
			}
		}
	});

	function findParentProject(items: TreeItem[], childId: string): TreeItem | null {
		for (const item of items) {
			if (item.children) {
				for (const child of item.children) {
					if (child.id === childId && child.type === 'deployment') {
						return item;
					}
					if (child.children) {
						const found = findParentProject([child], childId);
						if (found) return item;
					}
				}
			}
		}
		return null;
	}

	function findParentWorkspace(items: TreeItem[], childId: string): TreeItem | null {
		for (const item of items) {
			if (item.children) {
				for (const child of item.children) {
					if (child.id === childId) {
						return item;
					}
					if (child.children) {
						const found = findParentWorkspace(child.children, childId);
						if (found) {
							return item;
						}
					}
				}
			}
		}
		return null;
	}
</script>

<aside class="sidebar transition-all duration-200" style="width: {collapsed ? '4rem' : '16rem'};">
	<div class="flex h-full flex-col">
		<div class="sidebar-team-bar p-3">
			{#if collapsed}
				<div class="flex flex-col gap-2">
					<div class="flex justify-center">
						<button
							onclick={() => collapsed = !collapsed}
							class="sidebar-action rounded p-1"
							aria-label="Expand sidebar"
						>
							<PanelLeft class="h-5 w-5" />
						</button>
					</div>
					{#if $selectedOrganization}
						<a href="/organizations/{$selectedOrganization.slug}/settings" class="flex justify-center">
							{#if $selectedOrganization.avatarUrl}
								<img
									src={$selectedOrganization.avatarUrl}
									alt={$selectedOrganization.name}
									class="h-8 w-8 rounded-lg object-cover"
								/>
							{:else}
								<div
									class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400"
								>
									<FolderKanban class="h-4 w-4" />
								</div>
							{/if}
						</a>
					{/if}
					<button
						onclick={() => quickSearchRef?.openSearch()}
						class="sidebar-action rounded p-1 flex justify-center"
						aria-label="Search"
						title="Search ({shortcutKey}K)"
					>
						<Search class="h-5 w-5" />
					</button>
				</div>
			{:else}
				<div class="flex items-center gap-2">
					<div class="flex-1">
						<WorkspacesMenu />
					</div>
					<button
						onclick={() => collapsed = !collapsed}
						class="sidebar-action rounded p-1"
						aria-label="Collapse sidebar"
					>
						<PanelLeftClose class="h-5 w-5" />
					</button>
				</div>
			{/if}
		</div>

		{#if !collapsed}
			<div class="px-3 pt-3 pb-3">
				<button
					type="button"
					onclick={() => quickSearchRef?.openSearch()}
					class="sidebar-search-trigger w-full"
				>
					<Search class="h-4 w-4" />
					<span class="sidebar-search-placeholder">Search...</span>
					<div class="sidebar-search-shortcut">
						{#if isMac}
							<span class="sidebar-search-key">⌘</span>
							<span class="sidebar-search-key">K</span>
						{:else}
							<span class="sidebar-search-key">Ctrl</span>
							<span class="sidebar-search-key">K</span>
						{/if}
					</div>
				</button>
			</div>
		{/if}

		{#if !collapsed}
			<nav class="sidebar-nav flex-1 overflow-y-auto p-3">
				{#if !$isSignedIn}
					<div class="sidebar-muted p-4 text-center text-sm">
						Sign in to view workspaces
					</div>
				{:else if $treeLoading}
					<div class="flex flex-col items-center justify-center py-8">
						<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
						<p class="sidebar-muted mt-2 text-xs">Loading...</p>
					</div>
				{:else if $treeError}
					<div class="sidebar-error p-4 text-sm">
						{$treeError}
					</div>
				{:else if treeItems.length === 0}
					<div class="sidebar-muted p-4 text-center text-sm">
						No workspaces yet
					</div>
				{:else}
					<ul {...treeBuilder.root} class="space-y-1 list-none p-0 m-0">
						{#snippet treeBranch(items: typeof treeBuilder['children'], depth: number = 0)}
							{#each items as item (item.id)}
								{@const node = item.item as TreeItem}
								{@const Icon = node ? getIcon(node.type) : FolderKanban}
								{@const isExpanded = item.expanded}
								{@const isSelected = item.selected}
								{@const hasChildren = !!(node?.children && node.children.length > 0)}
								{@const isItemActive = node ? isActive(node.href) : false}
								<li
									{...item.attrs}
									onkeydown={(event) => handleItemKeydown(event, node, item, hasChildren)}
									class="cursor-pointer rounded-sm !outline-none first:mt-0 focus-visible:outline-none [&:focus-visible>.tree-row>div]:ring-4"
								>
									<div
										class="tree-row py-1"
										style={`padding-left: ${depth}rem`}
										onclick={(event) => {
											if (event.button !== 0 || event.defaultPrevented) return;
											if (hasChildren) {
												item.toggleExpand();
											}
										}}
									>
										<div
											class={`sidebar-nav-pill ${isSelected || isItemActive ? 'is-active' : ''} ring-primary-500 flex items-center gap-2 rounded-xl px-3 py-1 text-sm transition ring-offset-2`}
										>
											<div class="flex items-center gap-2 min-w-0">
												<svelte:component this={Icon} class="h-4 w-4 flex-shrink-0" />
												<span class="select-none truncate">{node?.name || item.id}</span>
											</div>
											{#if node?.href}
												<button
													type="button"
													class="ml-auto sidebar-action rounded-md p-1"
													onclick={(event) => {
														event.stopPropagation();
														if (!node?.href) return;
														selectedId = item.id;
														goto(node.href);
													}}
												>
													<ArrowUpRight class="h-4 w-4" />
												</button>
											{/if}
										</div>
									</div>
									{#if hasChildren}
										<ul
											{...treeBuilder.group}
											class={`relative list-none p-0 ml-0 origin-left ${isExpanded ? '' : 'pointer-events-none'}`}
										>
											<div
												class="absolute bottom-2 top-2 w-px bg-gray-200 dark:bg-gray-700"
												style={`left: ${0.5 + depth}rem`}
											></div>
											{#if isExpanded}
												<div transition:slide>
													{@render treeBranch(item.children ?? [], depth + 1)}
												</div>
											{/if}
										</ul>
									{/if}
								</li>
							{/each}
						{/snippet}
						{@render treeBranch(treeBuilder.children, 0)}
					</ul>
				{/if}
			</nav>
		{:else}
			<div class="flex-1"></div>
		{/if}

		<div class="sidebar-footer p-3 mt-auto">
			{#if collapsed}
				<a href="/user/settings" class="flex justify-center">
					<div
						class="flex h-8 w-8 items-center justify-center rounded-full"
						style="background-color: var(--sidebar-text-hover-bg); color: var(--sidebar-text);"
					>
						<span class="text-sm font-medium">U</span>
					</div>
				</a>
			{:else}
				<UserMenu />
			{/if}
		</div>
	</div>
	<QuickSearch bind:this={quickSearchRef} />
</aside>
