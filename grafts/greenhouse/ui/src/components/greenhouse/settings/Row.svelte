<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ToggleRow } from '@orchard/graft-ui';

	let {
		title,
		description = null,
		checked = undefined,
		ontoggle = undefined,
		disabled = false,
		icon = undefined,
		control = undefined,
		children = undefined
	}: {
		title: string;
		description?: string | null;
		checked?: boolean;
		ontoggle?: (next: boolean) => void;
		disabled?: boolean;
		icon?: Snippet;
		control?: Snippet;
		children?: Snippet;
	} = $props();

	const toggle = $derived(checked !== undefined);
</script>

<div class="row" class:row--off={disabled && !toggle}>
	{#if toggle}
		<ToggleRow
			label={title}
			hint={description}
			{disabled}
			bind:checked={() => checked ?? false, (next) => ontoggle?.(next)}
		/>
	{:else}
		<div class="line">
			{#if icon}<span class="glyph">{@render icon()}</span>{/if}
			<span class="text">
				<span class="title">{title}</span>
				{#if description}<span class="hint">{description}</span>{/if}
			</span>
			{#if control}
				<span class="control">{@render control()}</span>
			{/if}
		</div>
	{/if}
	{#if children}
		<div class="extra">{@render children()}</div>
	{/if}
</div>

<style>
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		min-width: 0;
	}

	.row:not(:first-child) {
		border-top: 1px solid var(--gh-line-soft);
	}

	.row--off .line {
		opacity: 0.6;
	}

	.line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 2rem;
	}

	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.hint {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.control {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
	}

	.extra {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
</style>
