<script lang="ts">
	import type { Snippet } from 'svelte';
	import AsciiVine from '$lib/components/ui/AsciiVine.svelte';
	import { morphHeight, motionStagger } from '$lib/utils/motion.svelte';

	let {
		bloom = false,
		seed = 23,
		brand = null,
		ground = null,
		children,
		footer = undefined
	}: {
		bloom?: boolean;
		seed?: number;
		brand?: string | null;
		ground?: string | null;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let narrow = $state(false);

	$effect(() => {
		const mq = window.matchMedia('(max-width: 40rem)');
		narrow = mq.matches;
		const on = () => (narrow = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});

	const band = $derived<[number, number]>(narrow ? [0.8, 0.96] : [0.36, 0.66]);
</script>

<div
	class="auth"
	style:--brand={brand}
	style:--ground={ground}
	class:auth--branded={!!brand}
	class:auth--grounded={!!ground}
>
	<div class="field" aria-hidden="true">
		{#key narrow}<AsciiVine {seed} {band} {bloom} />{/key}
	</div>
	<div class="stage">
		<div class="sheet" {@attach motionStagger({ index: 0, from: { y: 10 } })}>
			<div class="morph" {@attach morphHeight}>
				<div class="body">{@render children()}</div>
			</div>
		</div>
		{#if footer}
			<div class="foot" {@attach motionStagger({ index: 3, from: { y: 6 } })}>
				{@render footer()}
			</div>
		{/if}
	</div>
</div>

<style>
	.auth {
		--sheet-pad: 1.75rem;
		--sheet-inner-r: 0.75rem;
		--sheet-r: calc((var(--sheet-inner-r) + var(--sheet-pad)) * var(--corner-scale));
		position: relative;
		min-height: 100dvh;
		isolation: isolate;
		background: var(--bg-app);
		color: var(--text-default);
	}
	.auth--grounded {
		background: var(--ground);
	}
	.auth--branded {
		--accent-solid: var(--brand);
		--accent-solid-hover: color-mix(in oklab, var(--brand) 86%, black);
		--accent-6: color-mix(in oklab, var(--brand) 45%, var(--bg-app));
		--accent-7: color-mix(in oklab, var(--brand) 65%, var(--bg-app));
		--accent-8: var(--brand);
		--accent-9: var(--brand);
		--accent-10: color-mix(in oklab, var(--brand) 70%, var(--text-default));
	}
	.field {
		position: fixed;
		inset: 0;
		z-index: -1;
		will-change: opacity;
	}
	.stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 1.25rem;
		min-height: 100dvh;
		padding: max(3rem, calc(50dvh - 13rem)) 1rem 3rem;
	}
	.sheet {
		width: min(100%, 23.5rem);
		padding: var(--sheet-pad);
		border-radius: var(--sheet-r);
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow:
			0 0 0 0.5px var(--rule-strong),
			var(--shadow-floating);
	}
	.morph {
		position: relative;
	}
	.morph:global([data-morphing]) {
		overflow: clip;
		overflow-clip-margin: 0.375rem;
	}
	.body {
		display: flow-root;
	}
	.foot {
		max-width: 23.5rem;
		text-align: center;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.foot :global(a) {
		color: var(--text-default);
		text-decoration: none;
	}
	.foot :global(a:hover) {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	@media (max-width: 40rem) {
		.stage {
			justify-content: flex-start;
			padding: 4.5rem 0.5rem 10rem;
		}
		.sheet {
			--sheet-pad: 1.25rem;
			background: transparent;
			box-shadow: none;
		}
	}
</style>
