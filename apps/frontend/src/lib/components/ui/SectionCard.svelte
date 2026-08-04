<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title = undefined,
		description = undefined,
		actions = undefined,
		class: className = '',
		children = undefined
	}: {
		title?: string;
		description?: string;
		actions?: Snippet;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<section class="card rounded-2xl p-5{className ? ` ${className}` : ''}">
	{#if title || actions}
		<div class="section-card-head">
			<div class="section-card-heading">
				{#if title}<h2 class="section-card-title">{title}</h2>{/if}
				{#if description}<p class="section-card-desc">{description}</p>{/if}
			</div>
			{#if actions}
				<div class="section-card-actions">{@render actions()}</div>
			{/if}
		</div>
	{/if}
	{@render children?.()}
</section>
