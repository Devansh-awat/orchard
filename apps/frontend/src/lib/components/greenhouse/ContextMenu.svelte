<script lang="ts">
	import type { Snippet } from 'svelte';
	import Menu from '$lib/components/ui/Menu.svelte';

	let {
		open = $bindable(false),
		x = 0,
		y = 0,
		children
	}: {
		open?: boolean;
		x?: number;
		y?: number;
		children: Snippet;
	} = $props();
</script>

<Menu bind:open placement="bottom-start">
	{#snippet trigger(props)}
		<span
			{...props}
			class="ctx-anchor"
			style="left: {x}px; top: {y - 6}px"
			aria-hidden="true"
			tabindex="-1"
		></span>
	{/snippet}
	{@render children()}
</Menu>

<style>
	.ctx-anchor {
		position: fixed;
		width: 1px;
		height: 1px;
		pointer-events: none;
	}
</style>
