<script lang="ts" generics="T">
	import { Skeleton } from 'skullet/svelte';
	import type { Snippet } from 'svelte';

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
