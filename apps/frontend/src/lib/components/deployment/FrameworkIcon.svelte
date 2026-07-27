<script lang="ts">
	import { Boxes, Globe } from 'lucide-svelte';
	import { FRAMEWORK_ICON_PATHS } from './framework-icons';

	let {
		framework,
		size = 16
	}: {
		framework: string | null | undefined;
		size?: number;
	} = $props();

	const path = $derived(framework ? FRAMEWORK_ICON_PATHS[framework] : undefined);
	const isStatic = $derived(framework === 'static' || framework === 'staticfile');
</script>

{#if path}
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="currentColor"
		role="presentation"
		aria-hidden="true"
	>
		<path d={path} />
	</svg>
{:else if isStatic}
	<Globe {size} />
{:else}
	<Boxes {size} />
{/if}
