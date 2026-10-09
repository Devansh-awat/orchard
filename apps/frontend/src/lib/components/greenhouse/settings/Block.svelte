<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		columns = 1,
		children
	}: {
		columns?: 1 | 2;
		children: Snippet;
	} = $props();
</script>

<div class="block" class:block--split={columns === 2}>
	{@render children()}
</div>

<style>
	.block {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		padding: 1.5rem 0;
	}

	.block:first-child {
		padding-top: 0.5rem;
	}

	.block:last-child {
		padding-bottom: 0;
	}

	.block + .block {
		border-top: 1px dotted var(--settings-rule, var(--gh-line));
	}

	.block--split {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	@media (max-width: 720px) {
		.block--split {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
