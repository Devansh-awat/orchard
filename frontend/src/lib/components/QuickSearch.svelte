<script lang="ts">
	import { goto } from '$app/navigation';
	import { tree, type TreeItem } from '$lib/stores';
	import { FolderKanban, Package, Rocket, Search, X, Database } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';

	let open = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);

	export function openSearch() {
		open = true;
		setTimeout(() => {
			const input = document.querySelector('.quick-search-input') as HTMLInputElement;
			input?.focus();
		}, 0);
	}

	function getIcon(type: TreeItem['type']) {
		switch (type) {
			case 'workspace':
				return FolderKanban;
			case 'project':
				return Package;
			case 'deployment':
				return Rocket;
			case 'database':
				return Database;
			default:
				return FolderKanban;
		}
	}

	interface SearchResult {
		item: TreeItem;
		workspace?: TreeItem;
		project?: TreeItem;
	}

	function flattenTreeItems(
		items: TreeItem[],
		parentWorkspace?: TreeItem,
		parentProject?: TreeItem
	): SearchResult[] {
		const result: SearchResult[] = [];
		for (const item of items) {
			if (item.type === 'workspace') {
				result.push({ item, workspace: item });
				if (item.children) {
					result.push(...flattenTreeItems(item.children, item, undefined));
				}
			} else if (item.type === 'project') {
				result.push({ item, workspace: parentWorkspace, project: item });
				if (item.children) {
					result.push(...flattenTreeItems(item.children, parentWorkspace, item));
				}
			} else if (item.type === 'deployment') {
				result.push({ item, workspace: parentWorkspace, project: parentProject });
			}
		}
		return result;
	}

	const searchResults = $derived.by(() => {
		if (!query.trim()) return [];
		const allResults = flattenTreeItems($tree);
		const lowerQuery = query.toLowerCase();
		return allResults.filter((result) =>
			result.item.name.toLowerCase().includes(lowerQuery)
		);
	});

	function handleKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
			event.preventDefault();
			if (open) {
				open = false;
				query = '';
				selectedIndex = 0;
			} else {
				openSearch();
			}
			return;
		}

		if (!open) return;

		if (event.key === 'Escape') {
			open = false;
			query = '';
			selectedIndex = 0;
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, searchResults.length - 1);
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			return;
		}

		if (event.key === 'Enter' && searchResults[selectedIndex]) {
			event.preventDefault();
			handleSelect(searchResults[selectedIndex].item);
			return;
		}
	}

	function handleSelect(item: TreeItem) {
		open = false;
		query = '';
		selectedIndex = 0;
		goto(item.href);
	}

	$effect(() => {
		if (searchResults.length > 0 && selectedIndex >= searchResults.length) {
			selectedIndex = searchResults.length - 1;
		}
	});

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});
</script>

{#if open}
	<div
		class="quick-search-overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) {
				open = false;
				query = '';
				selectedIndex = 0;
			}
		}}
		transition:fade={{ duration: 150 }}
	>
		<div class="quick-search-modal" transition:scale={{ duration: 150, start: 0.95 }}>
			<div class="quick-search-header">
				<div class="quick-search-input-wrapper">
					<Search class="quick-search-icon" />
					<input
						type="text"
						class="quick-search-input"
						placeholder="Search workspaces, projects, deployments..."
						bind:value={query}
						autofocus
					/>
					{#if query}
						<button
							type="button"
							class="quick-search-clear"
							onclick={() => {
								query = '';
								selectedIndex = 0;
							}}
						>
							<X class="h-4 w-4" />
						</button>
					{/if}
				</div>
			</div>

			<div class="quick-search-results">
				{#if query.trim() && searchResults.length === 0}
					<div class="quick-search-empty">
						<p class="quick-search-empty-text">No results found</p>
					</div>
				{:else if query.trim() && searchResults.length > 0}
					{#each searchResults as result, index (result.item.id)}
						{@const Icon = getIcon(result.item.type)}
						{@const isSelected = index === selectedIndex}
						{@const contextText = result.item.type === 'project' && result.workspace
							? result.workspace.name
							: result.item.type === 'deployment' && result.project && result.workspace
								? `${result.project.name} • ${result.workspace.name}`
								: null}
						<button
							type="button"
							class="quick-search-item"
							class:is-selected={isSelected}
							onclick={() => handleSelect(result.item)}
							onmouseenter={() => (selectedIndex = index)}
						>
							<svelte:component this={Icon} class="quick-search-item-icon" />
							<div class="quick-search-item-content">
								<div class="quick-search-item-name">{result.item.name}</div>
								{#if contextText}
									<div class="quick-search-item-context">{contextText}</div>
								{:else}
									<div class="quick-search-item-type">{result.item.type}</div>
								{/if}
							</div>
						</button>
					{/each}
				{:else}
					<div class="quick-search-empty">
						<p class="quick-search-empty-text">Start typing to search...</p>
					</div>
				{/if}
			</div>

			<div class="quick-search-footer">
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">↑↓</span>
					<span class="quick-search-hint-text">Navigate</span>
				</div>
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">↵</span>
					<span class="quick-search-hint-text">Select</span>
				</div>
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">Esc</span>
					<span class="quick-search-hint-text">Close</span>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.quick-search-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background-color: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 10vh;
	}

	.quick-search-modal {
		width: 100%;
		max-width: 32rem;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
		overflow: hidden;
	}

	:root.dark .quick-search-modal {
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3);
	}

	.quick-search-header {
		padding: 1rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.quick-search-input-wrapper {
		position: relative;
		display: flex;
		align-items: center;
        gap: 0.75rem;
	}

	.quick-search-icon {
		position: absolute;
		left: 0.75rem;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--surface-muted);
		pointer-events: none;
		z-index: 1;
	}

	.quick-search-input {
		width: 100%;
		margin: 0;
		padding: 0.75rem 0.75rem 0.75rem 2.1rem;
		font-size: 0.9375rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		color: var(--center-channel-color);
		outline: none;
		text-indent: 0;
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}

	.quick-search-input:focus {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
	}

	.quick-search-input::placeholder {
		color: var(--surface-muted);
	}

	.quick-search-clear {
		position: absolute;
		right: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		background-color: transparent;
		border: none;
		border-radius: 0.25rem;
		color: var(--surface-muted);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.quick-search-clear:hover {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	.quick-search-results {
		flex: 1;
		overflow-y: auto;
		max-height: 24rem;
		padding: 0.5rem;
	}

	.quick-search-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		text-align: left;
		background-color: transparent;
		border: none;
		border-radius: 0.5rem;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	.quick-search-item:hover,
	.quick-search-item.is-selected {
		background-color: var(--dropdown-hover-bg);
	}

	.quick-search-item-icon {
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		color: var(--surface-muted);
	}

	.quick-search-item-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.quick-search-item-name {
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quick-search-item-type {
		font-size: 0.75rem;
		text-transform: capitalize;
		color: var(--surface-muted);
	}

	.quick-search-item-context {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.quick-search-empty {
		padding: 3rem 1rem;
		text-align: center;
	}

	.quick-search-empty-text {
		font-size: 0.875rem;
		color: var(--surface-muted);
	}

	.quick-search-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--surface-border);
		background-color: var(--control-bg);
	}

	.quick-search-hint {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.quick-search-hint-key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.25rem;
		color: var(--center-channel-color);
	}

	.quick-search-hint-text {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}
</style>

