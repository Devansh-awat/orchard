<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		href = undefined,
		onclick = undefined,
		padding = 'md',
		class: className = '',
		children
	}: {
		href?: string;
		onclick?: (e: MouseEvent) => void;
		padding?: 'none' | 'sm' | 'md' | 'lg';
		class?: string;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} class="panel panel--interactive panel--pad-{padding} {className}"
		>{@render children()}</a
	>
{:else if onclick}
	<button type="button" {onclick} class="panel panel--interactive panel--pad-{padding} {className}"
		>{@render children()}</button
	>
{:else}
	<div class="panel panel--pad-{padding} {className}">{@render children()}</div>
{/if}

<style>
	.panel {
		position: relative;
		display: block;
		min-width: 0;
		border-radius: calc(var(--section-r, var(--radius-card)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		color: inherit;
		text-align: left;
		text-decoration: none;
	}
	.panel--pad-none {
		padding: 0;
	}
	.panel--pad-sm {
		padding: 0.75rem;
	}
	.panel--pad-md {
		padding: 1rem;
	}
	.panel--pad-lg {
		padding: 1.5rem;
	}
	.panel--interactive {
		cursor: pointer;
		transition: transform var(--spring-glide-duration) var(--spring-glide);
	}
	.panel--interactive::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: var(--shadow-floating);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-base) ease;
	}
	.panel--interactive:hover::after {
		opacity: 1;
	}
	.panel--interactive:active {
		transform: scale(0.99);
	}
</style>
