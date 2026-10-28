<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		hint = null,
		children
	}: {
		label: string;
		hint?: string | null;
		children: Snippet;
	} = $props();
</script>

<div class="row">
	<div class="info">
		<span class="label">{label}</span>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</div>
	<div class="action">{@render children()}</div>
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
	}
	.info {
		display: flex;
		flex: 1 1 16rem;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.label {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.action {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.5rem;
	}
</style>
