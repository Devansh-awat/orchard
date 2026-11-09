<script lang="ts" generics="T">
	import { instant } from 'skullet';
	import { Skeleton, SkulletProvider } from 'skullet/svelte';
	import type { Snippet } from 'svelte';
	import { effectiveAnimation } from '$lib/stores/preferences';

	let {
		data,
		sample,
		loading,
		empty,
		error,
		label,
		id,
		onreveal,
		children,
		emptyMessage,
		errorMessage,
		class: className,
		style
	}: {
		data?: T | null | PromiseLike<T>;
		sample?: T;
		loading?: boolean;
		empty?: boolean;
		error?: unknown;
		label?: string;
		id?: string;
		onreveal?: () => void;
		children?: Snippet<[T]>;
		emptyMessage?: Snippet;
		errorMessage?: Snippet<[unknown]>;
		class?: string;
		style?: string;
	} = $props();
</script>

<SkulletProvider reveal={$effectiveAnimation === 'off' ? instant : undefined}>
	<Skeleton
		{data}
		{sample}
		{loading}
		{empty}
		{error}
		{label}
		{id}
		{onreveal}
		{children}
		{emptyMessage}
		{errorMessage}
		class={className}
		{style}
	/>
</SkulletProvider>

<style>
	:global([skullet-reveal] *) {
		content-visibility: visible !important;
	}
	:global([skullet-loading]) {
		animation: data-pane-in var(--fade-long) var(--curve-out) calc(160ms * var(--tempo)) both;
	}
	@keyframes -global-data-pane-in {
		from {
			opacity: 0;
		}
	}
</style>
