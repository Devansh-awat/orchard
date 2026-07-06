<script lang="ts">
	import { ChevronRight } from 'lucide-svelte';

	interface Crumb {
		label: string;
		href?: string;
	}

	let { crumbs }: { crumbs: Crumb[] } = $props();
</script>

<nav class="bc" aria-label="Breadcrumb">
	{#each crumbs as crumb, i (i)}
		{#if i > 0}
			<ChevronRight size={12} class="bc-sep" />
		{/if}
		{#if crumb.href && i < crumbs.length - 1}
			<a href={crumb.href} class="bc-item bc-link">{crumb.label}</a>
		{:else}
			<span class="bc-item" class:bc-current={i === crumbs.length - 1}>{crumb.label}</span>
		{/if}
	{/each}
</nav>

<style>
	.bc {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 1rem;
	}

	.bc-item {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	.bc-link {
		text-decoration: none;
		transition: color 0.15s;
	}

	.bc-link:hover {
		color: var(--center-channel-color);
	}

	.bc-current {
		color: var(--center-channel-color);
		font-weight: 500;
	}

	:global(.bc-sep) {
		color: var(--surface-muted);
		opacity: 0.5;
		flex-shrink: 0;
	}
</style>
