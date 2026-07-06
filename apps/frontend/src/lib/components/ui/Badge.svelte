<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		tone = 'neutral',
		children
	}: {
		tone?: 'success' | 'warning' | 'error' | 'info' | 'neutral';
		children: Snippet;
	} = $props();
</script>

<span class="badge badge-{tone}">{@render children()}</span>
