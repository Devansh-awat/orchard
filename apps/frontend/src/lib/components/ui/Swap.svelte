<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	import { morphHeight } from '$lib/utils/motion.svelte';
	import { swap } from '$lib/utils/transitions';

	let { key, children }: { key: unknown; children: Snippet } = $props();

	const inModal = getContext<boolean>('ui-modal-entrance') ?? false;
	let settled = !inModal;
	$effect(() => {
		const frame = requestAnimationFrame(() => (settled = true));
		return () => cancelAnimationFrame(frame);
	});
</script>

<div class="swap" {@attach (el) => morphHeight(el as HTMLElement)}>
	<div class="inner">
		{#key key}
			<div class="pane" in:swap={{ enabled: settled }}>{@render children()}</div>
		{/key}
	</div>
</div>

<style>
	.swap {
		position: relative;
		min-width: 0;
	}
	.swap:global([data-morphing]) {
		overflow: clip;
		overflow-clip-margin: 0.375rem;
	}
	.inner,
	.pane {
		display: flow-root;
		min-width: 0;
	}
</style>
