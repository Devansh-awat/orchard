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
	let content = $state<HTMLElement>();
	let from = { width: 0, left: 0 };
	let first = true;
	let running: Animation[] = [];

	$effect.pre(() => {
		void collapsed;
		if (side && content) {
			from = {
				width: side.getBoundingClientRect().width,
				left: content.getBoundingClientRect().left
			};
		}
	});

	$effect(() => {
		void collapsed;
		untrack(() => {
			if (first || !side || !content) {
				first = false;
				return;
			}
			for (const a of running) a.cancel();
			const width = side.getBoundingClientRect().width;
			const left = content.getBoundingClientRect().left;
			if (Math.abs(width - from.width) < 1) return;
			const timing = springTiming('snap', { distance: Math.abs(width - from.width) });
			running = [
				side.animate([{ width: `${from.width}px` }, { width: `${width}px` }], timing),
				content.animate(
					[{ transform: `translateX(${from.left - left}px)` }, { transform: 'none' }],
					timing
				)
			];
		});
	});
</script>

<div class="frame" class:frame--collapsed={collapsed}>
	{#if backdrop}<div class="backdrop">{@render backdrop()}</div>{/if}
	<aside class="side" bind:this={side}>{@render sidebar()}</aside>
	<main class="content" bind:this={content}>{@render children()}</main>
</div>

<style>
	.frame {
		--side-w: 16rem;
		--rail-w: 3.25rem;
		position: relative;
		display: grid;
		grid-template-columns: var(--side-w) minmax(0, 1fr);
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
	.frame--collapsed {
		grid-template-columns: var(--rail-w) minmax(0, 1fr);
	}
	.side {
		position: relative;
		z-index: 1;
		min-width: 0;
		min-height: 0;
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
