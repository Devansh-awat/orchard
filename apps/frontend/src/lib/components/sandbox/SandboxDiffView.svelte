<script lang="ts">
	import { fade } from '$lib/utils/transitions';

	let { text, truncated = false }: { text: string; truncated?: boolean } = $props();

	const lines = $derived(text === '' ? [] : text.split('\n'));

	function lineClass(line: string): string {
		if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-line--meta';
		if (line.startsWith('@@')) return 'diff-line diff-line--hunk';
		if (line.startsWith('+')) return 'diff-line diff-line--add';
		if (line.startsWith('-')) return 'diff-line diff-line--del';
		if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-line diff-line--meta';
		return 'diff-line';
	}
</script>

{#if truncated}
	<p class="diff-truncated">Diff truncated. Pull the branch to see everything.</p>
{/if}
{#if lines.length === 0 || text.trim() === ''}
	<p class="diff-empty">No diff to show.</p>
{:else}
	<div class="diff-body" transition:fade>
		{#each lines as line, i (i)}
			<div class={lineClass(line)}>{line || ' '}</div>
		{/each}
	</div>
{/if}

<style>
	.diff-truncated {
		flex-shrink: 0;
		margin-bottom: 0.375rem;
		padding: 0.375rem 0.625rem;
		border: 1px solid var(--status-warning-border);
		border-radius: var(--radius-sm);
		background: var(--status-warning-bg);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}

	.diff-empty {
		padding: 1.25rem 0.5rem;
		text-align: center;
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.diff-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		padding: 0.5rem 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
	}

	.diff-line {
		padding: 0 0.625rem;
		white-space: pre;
		color: var(--text-default);
	}

	.diff-line--add {
		background: var(--status-success-bg);
		color: var(--status-success);
	}

	.diff-line--del {
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.diff-line--hunk {
		color: var(--accent);
		opacity: 0.75;
	}

	.diff-line--meta {
		color: var(--text-faint);
	}
</style>
