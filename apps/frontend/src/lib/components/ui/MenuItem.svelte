<script lang="ts">
	import { getContext, type Snippet } from 'svelte';

	let {
		onclick = undefined,
		href = undefined,
		danger = false,
		disabled = false,
		children,
		...rest
	}: {
		onclick?: (e: MouseEvent) => void;
		href?: string;
		danger?: boolean;
		disabled?: boolean;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const menu = getContext<{ close: () => void } | undefined>('ui-menu');

	function handleClick(e: MouseEvent) {
		onclick?.(e);
		menu?.close();
	}
</script>

{#if href && !disabled}
	<a
		{href}
		class="ui-menu-item"
		class:ui-menu-item--danger={danger}
		role="menuitem"
		onclick={handleClick}
		{...rest}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		type="button"
		class="ui-menu-item"
		class:ui-menu-item--danger={danger}
		role="menuitem"
		{disabled}
		onclick={handleClick}
		{...rest}
	>
		{@render children?.()}
	</button>
{/if}
