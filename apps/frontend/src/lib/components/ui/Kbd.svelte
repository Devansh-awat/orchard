<script lang="ts">
	let { keys }: { keys: string | string[] } = $props();
	const list = $derived(Array.isArray(keys) ? keys : [keys]);
</script>

<span class="kbds">
	{#each list as key, i (i)}<kbd class="kbd">{key}</kbd>{/each}
</span>

<style>
	.kbds {
		display: inline-flex;
		gap: 0.125rem;
	}
	.kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.25rem;
		border-radius: 0.3125rem;
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow:
			inset 0 0 0 1px var(--border-default),
			inset 0 -1px 0 var(--border-default);
		color: var(--text-muted);
		font-family: inherit;
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		line-height: 1;
	}
</style>
