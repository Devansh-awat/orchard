<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		sidebar,
		backdrop = undefined,
		children
	}: { sidebar: Snippet; backdrop?: Snippet; children: Snippet } = $props();
</script>

<div class="frame">
	{#if backdrop}<div class="backdrop">{@render backdrop()}</div>{/if}
	<aside class="side">{@render sidebar()}</aside>
	<main class="content">{@render children()}</main>
</div>

<style>
	.frame {
		position: relative;
		display: grid;
		grid-template-columns: 16rem minmax(0, 1fr);
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
