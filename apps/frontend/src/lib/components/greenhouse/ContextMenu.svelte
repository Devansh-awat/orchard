<script lang="ts">
	import type { Snippet } from 'svelte';
	import Menu from '$lib/components/ui/Menu.svelte';

	let {
		open = $bindable(false),
		x = 0,
		y = 0,
		placement = 'bottom-start',
		toggle = null,
		children
	}: {
		open?: boolean;
		x?: number;
		y?: number;
		placement?: 'bottom-start' | 'bottom-end';
		toggle?: HTMLElement | null;
		children: Snippet;
	} = $props();

	function inside(target: Element | Window | Document): boolean {
		return !!toggle && target instanceof Node && toggle.contains(target);
	}
</script>

<Menu bind:open {placement} {inside}>
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
		outline: none;
		box-shadow: none;
	}

	.ctx-anchor:focus,
	.ctx-anchor:focus-visible {
		outline: none;
		box-shadow: none;
	}
</style>
