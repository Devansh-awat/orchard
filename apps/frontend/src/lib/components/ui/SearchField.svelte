<script lang="ts">
	import { Search, X } from 'lucide-svelte';

	let {
		value = $bindable(''),
		placeholder = 'Search',
		shortcut = undefined,
		size = 'md',
		class: className = '',
		...rest
	}: {
		value?: string;
		placeholder?: string;
		shortcut?: string;
		size?: 'sm' | 'md';
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

<label class="search search--{size} {className}">
	<span class="icon" aria-hidden="true"><Search size={size === 'sm' ? 14 : 15} /></span>
	<input type="search" class="field" {placeholder} bind:value aria-label={placeholder} {...rest} />
	{#if value}
		<button type="button" class="clear" aria-label="Clear search" onclick={() => (value = '')}>
			<X size={12} strokeWidth={2.5} />
		</button>
	{:else if shortcut}
		<kbd class="kbd">{shortcut}</kbd>
	{/if}
</label>

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		height: 2rem;
		padding: 0 0.375rem 0 0.6875rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 6%, transparent);
		color: var(--text-muted);
		cursor: text;
		transition:
			background-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}
	.search--sm {
		height: 1.75rem;
		padding-left: 0.625rem;
	}
	.search:hover:not(:focus-within) {
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
	.search:focus-within {
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 1px var(--accent-solid),
			0 0 0 3.5px color-mix(in oklab, var(--accent-solid) 22%, transparent);
	}
	.icon {
		display: flex;
		flex-shrink: 0;
	}
	.field {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		outline: none;
		appearance: none;
	}
	.search--sm .field {
		font-size: var(--text-callout);
	}
	.field::placeholder {
		color: var(--text-muted);
	}
	.field::-webkit-search-cancel-button {
		appearance: none;
	}
	.clear {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.125rem;
		height: 1.125rem;
		margin-right: 0.25rem;
		border: none;
		border-radius: calc(0.3125rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--neutral-6);
		color: var(--bg-surface);
		cursor: pointer;
	}
	.kbd {
		flex-shrink: 0;
		padding: 0.1875rem 0.375rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 0.5px var(--border-strong);
		color: var(--text-muted);
		font-family: inherit;
		font-size: var(--text-micro);
		font-weight: var(--weight-medium);
	}
</style>
