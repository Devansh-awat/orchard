<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Loader2 } from 'lucide-svelte';

	let {
		variant = 'secondary',
		size = 'md',
		href = undefined,
		type = 'button',
		loading = false,
		disabled = false,
		class: className = '',
		children,
		...rest
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'md' | 'sm';
		href?: string;
		type?: 'button' | 'submit';
		loading?: boolean;
		disabled?: boolean;
		class?: string;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const classes = $derived(
		`btn btn-${variant}${size === 'sm' ? ' btn-sm' : ''}${className ? ` ${className}` : ''}`
	);
</script>

{#if href && !disabled}
	<a {href} class={classes} {...rest}>{@render children?.()}</a>
{:else}
	<button {type} class={classes} disabled={disabled || loading} {...rest}>
		{#if loading}<Loader2 class="h-4 w-4 animate-spin" />{/if}
		{@render children?.()}
	</button>
{/if}
