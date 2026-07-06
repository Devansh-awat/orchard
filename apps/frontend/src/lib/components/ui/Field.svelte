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

<div class="ui-field">
	{#if label}
		<label class="ui-field-label" for={htmlFor}>{label}</label>
	{/if}
	{@render children()}
	{#if error}
		<p class="ui-field-error">{error}</p>
	{:else if hint}
		<p class="ui-field-hint">{hint}</p>
	{/if}
</div>
