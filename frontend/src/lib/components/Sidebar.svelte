<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { Tree } from 'melt/builders';
	import { PanelLeftClose, PanelLeft, FolderKanban, Rocket, Loader2, ArrowUpRight, Search, Folder, Pin, Globe, Leaf, Database } from 'lucide-svelte';
	import WorkspacesMenu from './WorkspacesMenu.svelte';
	import UserMenu from './UserMenu.svelte';
	import QuickSearch from './QuickSearch.svelte';
	import { tree, treeLoading, treeError, type TreeItem, isSignedIn, selectedOrganization, pinnedItems } from '$lib/stores';
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
				return Folder;
			case 'deployment':
				return Rocket;
			case 'ingress':
				return Globe;
			case 'database':
				return Database;
			default:
				return FolderKanban;
		}
	}

	function getIconBadgeColor(type: TreeItem['type']) {
		switch (type) {
			case 'workspace':
				return 'var(--sidebar-text-active-border)';
			case 'project':
				return '#4a8aff';
			case 'deployment':
				return '#f5a623';
			case 'ingress':
				return '#a78bfa';
			case 'database':
				return '#22c55e';
			default:
				return 'var(--sidebar-text-active-border)';
		}
	}

	function isActive(href: string) {
		return $page.url.pathname === href || $page.url.pathname.startsWith(href + '/');
	}


	let lastPathname = $state('');

	$effect(() => {
		const pathname = $page.url.pathname;
		if (pathname === lastPathname) return;
		lastPathname = pathname;

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
			if (activeItem.type === 'deployment' || activeItem.type === 'ingress' || activeItem.type === 'database') {
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
					if (child.id === childId && (child.type === 'deployment' || child.type === 'ingress' || child.type === 'database')) {
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
						<a href="/{$selectedOrganization.slug}/settings" class="flex justify-center">
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
					<a
						href="/{$selectedOrganization?.slug ?? ''}"
						class="sidebar-action rounded p-1 flex justify-center"
						aria-label="Home"
						title="Home"
					>
						<Leaf class="h-5 w-5" />
					</a>
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
			<div class="px-3 pt-3 pb-1">
				<button
					type="button"
					onclick={() => quickSearchRef?.openSearch()}
					class="sidebar-search-trigger w-full"
				>
					<div class="sidebar-search-icon-wrapper">
						<Search class="h-3.5 w-3.5" />
					</div>
					<span class="sidebar-search-placeholder">Search</span>
					<kbd class="sidebar-search-kbd">{isMac ? '⌘' : 'Ctrl'}K</kbd>
				</button>
			</div>
			<div class="px-3 pt-4">
				<a
					href="/{$selectedOrganization?.slug ?? ''}"
					class="tree-node-content"
					class:is-active={$page.url.pathname === '/' + ($selectedOrganization?.slug ?? '')}
				>
					<div class="tree-icon-badge" style="background-color: #22c55e">
						<Leaf size={10} class="tree-icon-svg" />
					</div>
					<span class="tree-node-label">Home</span>
				</a>
			</div>
		{/if}

		{#if !collapsed}
			<nav class="sidebar-nav flex-1 overflow-y-auto px-3 pb-3 pt-0">
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
					{#if $pinnedItems.length > 0}
						<div class="pinned-section">
							<div class="pinned-section-header">
								<Pin size={11} />
								<span>Pinned</span>
							</div>
							<ul class="tree-root list-none p-0 m-0">
								{#each $pinnedItems as pinned (pinned.id)}
									{@const PinnedIcon = getIcon(pinned.type)}
									{@const pinnedBadgeColor = getIconBadgeColor(pinned.type)}
									<li>
										<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
										<div
											class="tree-node-content"
											class:is-active={isActive(pinned.href)}
											onclick={() => goto(pinned.href)}
										>
											<div class="tree-icon-badge" style="background-color: {pinnedBadgeColor}">
												<PinnedIcon size={10} class="tree-icon-svg" />
											</div>
											<span class="tree-node-label">{pinned.name}</span>
											<button
												type="button"
												class="tree-pin-btn is-pinned"
												onclick={(event) => {
													event.stopPropagation();
													pinnedItems.unpin(pinned.id);
												}}
												aria-label="Unpin {pinned.name}"
											>
												<Pin size={12} />
											</button>
										</div>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<ul {...treeBuilder.root} class="tree-root list-none p-0 m-0">
						{#snippet treeBranch(items: typeof treeBuilder['children'], depth: number = 0)}
							{#each items as item, idx (item.id)}
								{@const node = item.item as TreeItem}
								{@const Icon = node ? getIcon(node.type) : FolderKanban}
								{@const isExpanded = item.expanded}
								{@const isSelected = item.selected}
								{@const hasChildren = !!(node?.children && node.children.length > 0)}
								{@const isItemActive = node ? isActive(node.href) : false}
								{@const isLast = idx === items.length - 1}
								{@const badgeColor = node ? getIconBadgeColor(node.type) : 'var(--sidebar-text-active-border)'}
								<li
									{...item.attrs}
									onkeydown={(event) => handleItemKeydown(event, node, item, hasChildren)}
									class="cursor-pointer !outline-none focus-visible:outline-none"
								>
									<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
									<div
										class="tree-node-content"
										class:is-active={isSelected || isItemActive}
										onclick={(event) => {
											if (event.button !== 0 || event.defaultPrevented) return;
											if (hasChildren) {
												item.toggleExpand();
											} else if (node?.href) {
												if ($page.url.pathname === node.href) {
													const el = event.currentTarget as HTMLElement;
													el.classList.remove('tree-nudge');
													void el.offsetWidth;
													el.classList.add('tree-nudge');
												} else {
													selectedId = item.id;
													goto(node.href);
												}
											}
										}}
									>
										<div class="tree-icon-badge" style="background-color: {badgeColor}">
											<Icon size={10} class="tree-icon-svg" />
										</div>
										<span class="tree-node-label">{node?.name || item.id}</span>
										<div class="tree-node-actions">
											{#if node}
												<button
													type="button"
													class="tree-pin-btn"
													class:is-pinned={pinnedItems.isPinned(node.id)}
													onclick={(event) => {
														event.stopPropagation();
														if (!node) return;
														const btn = event.currentTarget as HTMLElement;
														const row = btn.closest('.tree-node-content') as HTMLElement;
														btn.classList.remove('pin-pop');
														void btn.offsetWidth;
														btn.classList.add('pin-pop');
														if (!pinnedItems.isPinned(node.id) && row) {
															row.classList.remove('pin-flash');
															void row.offsetWidth;
															row.classList.add('pin-flash');
														}
														pinnedItems.toggle({ id: node.id, name: node.name, type: node.type, href: node.href });
													}}
													aria-label="{pinnedItems.isPinned(node.id) ? 'Unpin' : 'Pin'} {node.name}"
												>
													<Pin size={12} />
												</button>
											{/if}
											{#if node?.href && hasChildren}
												<button
													type="button"
													class="tree-node-action"
													onclick={(event) => {
														event.stopPropagation();
														if (!node?.href) return;
														selectedId = item.id;
														goto(node.href);
													}}
												>
													<ArrowUpRight class="h-3.5 w-3.5" />
												</button>
											{/if}
										</div>
									</div>
									{#if hasChildren}
										<ul
											{...treeBuilder.group}
											class="tree-children list-none p-0 m-0"
											class:pointer-events-none={!isExpanded}
										>
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
