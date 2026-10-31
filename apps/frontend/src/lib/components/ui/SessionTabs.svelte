<script lang="ts">
	import { X } from 'lucide-svelte';
	import type { SessionTab } from './session-tabs';

	let {
		items,
		value = $bindable(''),
		label,
		onselect = undefined,
		onclose = undefined
	}: {
		items: SessionTab[];
		value?: string;
		label: string;
		onselect?: (id: string) => void;
		onclose?: (id: string) => void;
	} = $props();

	function select(id: string) {
		value = id;
		onselect?.(id);
	}
</script>

<div class="sessions" role="tablist" aria-label={label}>
	{#each items as item (item.id)}
		{@const Icon = item.icon}
		<span
			class="session"
			class:session--closable={item.closable && !!onclose}
			class:session--bell={item.bell && value !== item.id}
			class:session--active={value === item.id}
		>
			<button
				type="button"
				role="tab"
				class="hit"
				aria-selected={value === item.id}
				title={item.title ?? item.label}
				onclick={() => select(item.id)}
			>
				{#if Icon}<Icon size={13} aria-hidden="true" />{/if}
				<span class="title">{item.label}</span>
			</button>
			{#if item.closable && onclose}
				<button
					type="button"
					class="close"
					aria-label="Close {item.label}"
					onclick={() => onclose?.(item.id)}
				>
					<X size={12} />
				</button>
			{/if}
		</span>
	{/each}
</div>

<style>
	.sessions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		margin-block: -0.25rem;
		padding-block: 0.25rem;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.session {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 1.75rem;
		border-radius: 999px;
		color: var(--console-dim, var(--text-muted));
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.session:has(.hit:hover) {
		background: var(--console-hover, var(--bg-hover));
		color: var(--console-text, var(--text-default));
	}
	.session--active,
	.session--active:has(.hit:hover) {
		background: var(--bg-surface);
		color: var(--console-text, var(--text-default));
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
	.session--bell {
		color: var(--status-warning);
	}
	.hit {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 12rem;
		height: 100%;
		padding: 0 0.75rem;
		border-radius: inherit;
		color: inherit;
		cursor: pointer;
	}
	.session--closable .hit {
		padding-right: 0.125rem;
	}
	.hit:focus-visible,
	.close:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.close {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		margin-right: 0.25rem;
		border-radius: 50%;
		color: var(--console-faint, var(--text-faint));
		cursor: pointer;
	}
	.close:hover {
		background: var(--console-hover, var(--bg-hover));
		color: var(--console-text, var(--text-default));
	}
</style>
