<script lang="ts">
	import { CircleAlert } from 'lucide-svelte';

	let { detail }: { detail: string } = $props();
</script>

<div class="err" role="alert">
	<CircleAlert class="h-4 w-4 shrink-0" />
	<span class="err-text">{detail}</span>
</div>

<style>
	.err {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--status-error-border);
		border-radius: var(--radius-md);
		background: var(--status-error-bg);
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--status-error);
	}

	.err-text {
		min-width: 0;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
