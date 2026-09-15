<script lang="ts">
	import { theme } from '$lib/theme.svelte';

	let {
		name,
		alt,
		width = 1600,
		height = 1000,
		priority = false,
		class: className = ''
	}: {
		name: string;
		alt: string;
		width?: number;
		height?: number;
		priority?: boolean;
		class?: string;
	} = $props();

	const src = $derived(
		theme.resolved === 'dark' ? `/screenshots/${name}-dark.png` : `/screenshots/${name}.png`
	);
</script>

<div class="shot shot-lift {className}">
	<img
		{src}
		{alt}
		{width}
		{height}
		loading={priority ? 'eager' : 'lazy'}
		fetchpriority={priority ? 'high' : 'auto'}
		class="w-full"
	/>
</div>
