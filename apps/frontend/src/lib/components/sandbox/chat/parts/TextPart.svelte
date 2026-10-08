<script lang="ts">
	import { renderMarkdown } from '../markdown';

	let { text, compact = false }: { text: string; compact?: boolean } = $props();

	const html = $derived(renderMarkdown(text));
</script>

<div class="md" class:md--compact={compact}>{@html html}</div>

<style>
	.md {
		font-size: var(--text-callout);
		line-height: 1.65;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.md--compact {
		font-size: var(--text-footnote);
	}

	.md :global(p) {
		margin: 0.5rem 0;
	}

	.md > :global(:first-child) {
		margin-top: 0;
	}

	.md > :global(:last-child) {
		margin-bottom: 0;
	}

	.md :global(ul),
	.md :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.375rem;
	}

	.md :global(ul) {
		list-style: disc;
	}

	.md :global(ol) {
		list-style: decimal;
	}

	.md :global(li) {
		margin: 0.1875rem 0;
	}

	.md :global(li::marker) {
		color: var(--text-faint);
	}

	.md :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: 0.875em;
		padding: 0.0625rem 0.3125rem;
		border-radius: var(--radius-xs);
		background: var(--fill-soft);
	}

	.md :global(pre) {
		margin: 0.625rem 0;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-sunken);
		overflow-x: auto;
	}

	.md :global(pre code) {
		padding: 0;
		border-radius: 0;
		background: none;
		font-size: var(--text-caption);
		line-height: 1.55;
	}

	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 1rem 0 0.375rem;
		font-size: var(--text-callout);
		font-weight: 700;
		color: var(--text-default);
	}

	.md :global(h1),
	.md :global(h2) {
		font-size: var(--text-headline);
	}

	.md :global(a) {
		color: var(--text-link);
		text-decoration: none;
	}

	.md :global(a:hover) {
		text-decoration: underline;
	}

	.md :global(blockquote) {
		margin: 0.5rem 0;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-muted);
	}

	.md :global(table) {
		margin: 0.625rem 0;
		border-collapse: collapse;
		font-size: var(--text-footnote);
	}

	.md :global(th),
	.md :global(td) {
		padding: 0.25rem 0.625rem;
		border: 1px solid var(--border-default);
		text-align: left;
	}

	.md :global(hr) {
		margin: 1rem 0;
		border: none;
		border-top: 1px solid var(--border-default);
	}
</style>
