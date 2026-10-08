<script lang="ts">
	import { CircleAlert } from 'lucide-svelte';

	let { detail }: { detail: string } = $props();
</script>

<div class="err" role="alert" data-align="content">
	<span class="err-glyph" aria-hidden="true"><CircleAlert size={16} strokeWidth={1.75} /></span>
	<p class="err-text"><span class="err-label">Failed</span> {detail}</p>
</div>

<style>
	.err {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		min-width: 0;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
	}

	.err-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		margin-top: 0.125rem;
		color: var(--status-error);
	}

	.err-text {
		min-width: 0;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.err-label {
		font-weight: 600;
		color: var(--text-default);
	}
</style>
