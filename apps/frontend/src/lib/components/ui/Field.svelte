<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label = undefined,
		hint = undefined,
		error = undefined,
		for: htmlFor = undefined,
		children
	}: {
		label?: string;
		hint?: string;
		error?: string | null;
		for?: string;
		children: Snippet;
	} = $props();
</script>

<div class="field">
	{#if label}<label class="label" for={htmlFor}>{label}</label>{/if}
	{@render children()}
	{#if error}
		<p class="msg msg--error" role="alert">{error}</p>
	{:else if hint}
		<p class="msg">{hint}</p>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.label {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.msg {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.msg--error {
		color: var(--status-error);
	}
</style>
