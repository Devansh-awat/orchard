<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		ratio = 'even',
		children
	}: {
		ratio?: 'even' | 'golden';
		children: Snippet;
	} = $props();
</script>

<div class="frame">
	<div class="grid grid--{ratio}">{@render children()}</div>
</div>

<style>
	.frame {
		container-type: inline-size;
		min-width: 0;
	}
	.grid {
		display: grid;
		gap: var(--space-4) var(--space-3);
	}
	.grid--even {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.grid--golden {
		grid-template-columns: minmax(0, 38.2fr) minmax(0, 61.8fr);
	}
	@container (max-width: 30rem) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
