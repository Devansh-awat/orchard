<script lang="ts">
	import type { Snippet } from 'svelte';
	import { TriangleAlert, CircleAlert, Info, CircleCheck } from 'lucide-svelte';

	let {
		tone = 'info',
		title = undefined,
		icon = undefined,
		children = undefined
	}: {
		tone?: 'error' | 'warning' | 'info' | 'success';
		title?: string;
		icon?: Snippet;
		children?: Snippet;
	} = $props();

	const DEFAULT_ICONS = {
		error: CircleAlert,
		warning: TriangleAlert,
		info: Info,
		success: CircleCheck
	} as const;
	const DefaultIcon = $derived(DEFAULT_ICONS[tone]);
</script>

<div class="alert alert-{tone}" role="alert">
	<span class="alert-icon">
		{#if icon}{@render icon()}{:else}<DefaultIcon size={15} />{/if}
	</span>
	<div class="alert-content">
		{#if title}<p class="alert-title">{title}</p>{/if}
		{#if children}<div class="alert-body">{@render children()}</div>{/if}
	</div>
</div>
