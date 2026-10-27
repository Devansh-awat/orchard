<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { springTiming } from '$lib/utils/motion.svelte';

	let {
		sidebar,
		backdrop = undefined,
		collapsed = false,
		children
	}: {
		sidebar: Snippet;
		backdrop?: Snippet;
		collapsed?: boolean;
		children: Snippet;
	} = $props();

	let side = $state<HTMLElement>();
	let from = 0;
	let first = true;
	let running: Animation | null = null;

	$effect.pre(() => {
		void collapsed;
		if (side) from = side.getBoundingClientRect().width;
	});

	$effect(() => {
		const closing = collapsed;
		untrack(() => {
			if (first || !side) {
				first = false;
				return;
			}
			running?.cancel();
			const to = side.getBoundingClientRect().width;
			if (Math.abs(to - from) < 1) return;
			running = side.animate(
				[{ width: `${from}px` }, { width: `${to}px` }],
				springTiming(closing ? 'settle' : 'snap', { distance: Math.abs(to - from) })
			);
			running.onfinish = () => (running = null);
		});
	});
</script>

<div class="frame" class:frame--collapsed={collapsed}>
	{#if backdrop}<div class="backdrop">{@render backdrop()}</div>{/if}
	<aside class="side" bind:this={side}>{@render sidebar()}</aside>
	<main class="content">{@render children()}</main>
</div>

<style>
	.frame {
		--side-w: 16rem;
		--rail-w: 3.75rem;
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.75rem;
		height: 100dvh;
		padding: 0.625rem;
		overflow: hidden;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}
	.side {
		position: relative;
		z-index: 1;
		width: var(--side-w);
		min-height: 0;
	}
	.frame--collapsed .side {
		width: var(--rail-w);
	}
	.content {
		position: relative;
		min-width: 0;
		margin: -0.625rem -0.625rem -0.625rem 0;
		overflow-y: auto;
	}
	@media (max-width: 900px) {
		.frame {
			grid-template-columns: minmax(0, 1fr);
		}
		.side {
			display: none;
		}
	}
</style>
