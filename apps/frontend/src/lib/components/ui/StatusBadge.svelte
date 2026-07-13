<script lang="ts">
	import type { StatusMeta } from './status';
	import StatusDot from './StatusDot.svelte';

	let {
		meta,
		variant = 'subtle'
	}: {
		meta: StatusMeta;
		variant?: 'subtle' | 'plain';
	} = $props();
</script>

{#if variant === 'subtle'}
	<span class="sb sb--subtle status--{meta.kind}">
		<StatusDot {meta} size={6} />
		{meta.label}
	</span>
{:else}
	<span class="sb sb--plain">
		<StatusDot {meta} size={6} />
		{meta.label}
	</span>
{/if}

<style>
	.sb {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.6875rem;
		font-weight: 550;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.sb--subtle {
		padding: 0.1875rem 0.625rem;
		border-radius: 2rem;
		background-color: color-mix(in srgb, currentColor 10%, transparent);
	}

	.sb--plain {
		color: var(--text-default);
	}
</style>
