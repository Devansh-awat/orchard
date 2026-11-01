<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		hint = undefined,
		for: htmlFor = undefined,
		wide = false,
		stack = false,
		children
	}: {
		label: string;
		hint?: string | Snippet;
		for?: string;
		wide?: boolean;
		stack?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="setting" class:setting--wide={wide} class:setting--stack={stack}>
	<div class="info">
		{#if htmlFor}
			<label class="label" for={htmlFor}>{label}</label>
		{:else}
			<span class="label">{label}</span>
		{/if}
		{#if hint}
			<span class="hint"
				>{#if typeof hint === 'string'}{hint}{:else}{@render hint()}{/if}</span
			>
		{/if}
	</div>
	<div class="control">{@render children()}</div>
</div>

<style>
	.setting {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		min-width: 0;
	}
	.info {
		display: flex;
		flex: 1 1 auto;
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
	.hint :global(code) {
		font-family: var(--font-mono);
		font-size: 0.95em;
		line-height: 1;
		color: var(--text-default);
	}
	.control {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		min-width: 0;
		max-width: 61.8%;
	}
	.setting--wide .control {
		flex: 0 0 61.8%;
	}
	.setting--wide .control > :global(*) {
		flex: 1 1 auto;
		min-width: 0;
	}
	.setting--stack {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-2);
	}
	.setting--stack .control {
		flex: 1 1 auto;
		justify-content: stretch;
		max-width: none;
	}
	.setting--stack .control > :global(*) {
		flex: 1 1 auto;
		min-width: 0;
	}
	@container (max-width: 34rem) {
		.setting--wide {
			flex-direction: column;
			align-items: stretch;
			gap: var(--space-2);
		}
		.setting--wide .control {
			flex-basis: auto;
			max-width: none;
		}
	}
</style>
