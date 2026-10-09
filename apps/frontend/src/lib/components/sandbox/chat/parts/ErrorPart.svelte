<script lang="ts">
	import { CircleAlert } from 'lucide-svelte';

	let { detail, auth = false }: { detail: string; auth?: boolean } = $props();
</script>

<div class="err" role="alert" data-align="content">
	<span class="err-glyph" aria-hidden="true"><CircleAlert size={16} strokeWidth={1.75} /></span>
	<div class="err-body">
		<p class="err-text"><span class="err-label">Failed</span> {detail}</p>
		{#if auth}
			<p class="err-hint">
				The agent could not sign in to its model provider.
				<a href="/user/settings?tab=sandbox">Add your Claude token in Settings → Sandbox</a>
			</p>
		{/if}
	</div>
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

	.err-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
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

	.err-hint {
		color: var(--text-muted);
	}

	.err-hint a {
		color: var(--text-link);
		text-decoration: none;
	}

	.err-hint a:hover {
		text-decoration: underline;
	}
</style>
