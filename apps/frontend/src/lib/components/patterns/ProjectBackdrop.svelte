<script lang="ts">
	import Aura from '$lib/components/ui/Aura.svelte';

	let { name, image = undefined }: { name: string; image?: string | null } = $props();
</script>

<div class="backdrop">
	<Aura class="field" src={image} {name} />
	<div class="fade"></div>
</div>

<style>
	.backdrop {
		position: absolute;
		inset: 0;
		animation: glow-in 700ms ease-out both;
	}
	.backdrop :global(.field) {
		position: absolute;
		inset: 0 0 auto;
		height: 34rem;
	}
	.fade {
		position: absolute;
		inset: 0 0 auto;
		height: 34rem;
		background: linear-gradient(
			to bottom,
			color-mix(in oklab, var(--bg-app) 0%, transparent) 0%,
			color-mix(in oklab, var(--bg-app) 30%, transparent) 22%,
			color-mix(in oklab, var(--bg-app) 86%, transparent) 42%,
			var(--bg-app) 70%
		);
	}
	@keyframes glow-in {
		from {
			opacity: 0;
		}
	}
</style>
