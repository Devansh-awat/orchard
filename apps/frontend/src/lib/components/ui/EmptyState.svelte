<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description = undefined,
		icon = undefined,
		children = undefined
	}: {
		title: string;
		description?: string;
		icon?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<div class="ui-empty">
	{#if icon}
		<div class="ui-empty-icon">{@render icon()}</div>
	{/if}
	<h3 class="ui-empty-title">{title}</h3>
	{#if description}
		<p class="ui-empty-desc">{description}</p>
	{/if}
	{#if children}
		<div class="ui-empty-action">{@render children()}</div>
	{/if}
</div>
