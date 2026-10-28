<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronsUpDown, X } from 'lucide-svelte';
	import Spinner from './Spinner.svelte';

	let {
		prefix = undefined,
		value = undefined,
		placeholder = 'Select',
		leading = undefined,
		open = false,
		loading = false,
		size = 'md',
		onclear = undefined,
		...rest
	}: {
		prefix?: string;
		value?: string | null;
		placeholder?: string;
		leading?: Snippet;
		open?: boolean;
		loading?: boolean;
		size?: 'sm' | 'md';
		onclear?: () => void;
		[key: string]: unknown;
	} = $props();
</script>

<span class="wrap">
	<button
		type="button"
		class="trigger trigger--{size}"
		class:trigger--open={open}
		class:trigger--clearable={!!onclear && !!value}
		{...rest}
	>
		{#if leading}<span class="leading">{@render leading()}</span>{/if}
		{#if prefix}<span class="prefix">{prefix}</span>{/if}
		<span class="value" class:value--empty={!value}>{value || placeholder}</span>
		{#if loading}
			<Spinner size={13} />
		{:else}
			<ChevronsUpDown size={14} class="chev" />
		{/if}
	</button>
	{#if onclear && value}
		<button type="button" class="clear" aria-label="Clear" onclick={onclear}><X size={13} /></button
		>
	{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
		min-width: 0;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		max-width: 100%;
		height: 2rem;
		padding: 0 0.5rem 0 0.625rem;
		border: none;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-raised);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.trigger--sm {
		height: 1.75rem;
		padding: 0 0.4375rem 0 0.5rem;
		border-radius: calc(0.5rem * var(--corner-scale));
		font-size: var(--text-callout);
	}
	.trigger--clearable {
		padding-right: 1.75rem;
	}
	.trigger:hover:not(:disabled),
	.trigger--open {
		background: var(--bg-hover);
	}
	.trigger:focus-visible {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--accent-solid),
			0 0 0 3px var(--focus-ring);
	}
	.trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.leading {
		display: inline-flex;
		flex-shrink: 0;
	}
	.prefix {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.value {
		min-width: 0;
		overflow: hidden;
		font-weight: var(--weight-medium);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.value--empty {
		font-weight: var(--weight-regular);
		color: var(--text-muted);
	}
	.trigger :global(.chev) {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.clear {
		position: absolute;
		top: 50%;
		right: 0.25rem;
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border: none;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transform: translateY(-50%);
	}
	.clear:hover {
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
		color: var(--text-default);
	}
</style>
