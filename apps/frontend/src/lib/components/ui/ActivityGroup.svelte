<script lang="ts">
	import type { Snippet } from 'svelte';
	import Eyebrow from './Eyebrow.svelte';

	let {
		label = undefined,
		class: klass = '',
		children
	}: {
		label?: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<section class="ui-agroup {klass}">
	{#if label}
		<div class="ui-agroup-label">
			<span class="ui-agroup-mark" aria-hidden="true"></span>
			<Eyebrow>{label}</Eyebrow>
		</div>
	{/if}
	<div class="ui-agroup-list" role="list">{@render children()}</div>
</section>

<style>
	.ui-agroup {
		display: flex;
		flex-direction: column;
	}
	.ui-agroup-label {
		display: grid;
		grid-template-columns: 3.25rem 1rem minmax(0, 1fr);
		gap: var(--space-2);
		align-items: center;
		padding: var(--space-3) 0 var(--space-1);
	}
	.ui-agroup-label > :global(.ui-eyebrow) {
		grid-column: 3;
	}
	.ui-agroup-mark {
		grid-column: 2;
		justify-self: center;
		width: 0.3125rem;
		height: 0.3125rem;
		border-radius: calc(1px * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--text-faint);
		transform: rotate(45deg);
	}
	.ui-agroup-list {
		display: flex;
		flex-direction: column;
	}
	@media (max-width: 760px) {
		.ui-agroup-label {
			grid-template-columns: 1rem minmax(0, 1fr);
		}
		.ui-agroup-mark {
			grid-column: 1;
		}
		.ui-agroup-label > :global(.ui-eyebrow) {
			grid-column: 2;
		}
	}
</style>
