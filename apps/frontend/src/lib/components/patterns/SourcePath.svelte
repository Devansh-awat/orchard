<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		owner,
		repo,
		details = undefined
	}: {
		owner: Snippet;
		repo: Snippet;
		details?: Snippet;
	} = $props();
</script>

<div class="source">
	<div class="path">
		<div class="owner">{@render owner()}</div>
		<span class="sep" aria-hidden="true">/</span>
		<div class="repo">{@render repo()}</div>
	</div>
	{#if details}<div class="details">{@render details()}</div>{/if}
</div>

<style>
	.source {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
	}
	.path {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}
	.owner {
		display: flex;
		flex-shrink: 0;
		max-width: 38.2%;
		min-width: 0;
	}
	.sep {
		flex-shrink: 0;
		font-size: var(--text-title-3);
		font-weight: var(--weight-regular);
		color: var(--text-faint);
	}
	.repo {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.details {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	@media (max-width: 40rem) {
		.path {
			flex-wrap: wrap;
		}
		.owner {
			max-width: none;
		}
		.sep {
			display: none;
		}
		.repo {
			flex-basis: 100%;
		}
	}
</style>
