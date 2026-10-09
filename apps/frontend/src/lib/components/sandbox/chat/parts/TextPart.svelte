<script lang="ts">
	import { renderMarkdown } from '../markdown';

	let {
		text,
		compact = false,
		align = false
	}: { text: string; compact?: boolean; align?: boolean } = $props();

	const html = $derived(renderMarkdown(text));
</script>

<div class="md" class:md--compact={compact} data-align={align ? 'content' : undefined}>
	{@html html}
</div>

<style>
	.md {
		min-width: 0;
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.md--compact {
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		color: var(--text-muted);
	}

	.md :global(p) {
		margin: var(--space-3) 0;
	}

	.md > :global(:first-child) {
		margin-top: 0;
	}

	.md > :global(:last-child) {
		margin-bottom: 0;
	}

	.md--compact :global(p) {
		margin: var(--space-2) 0;
	}

	.md :global(ul),
	.md :global(ol) {
		margin: var(--space-3) 0;
		padding-left: var(--space-6);
	}

	.md :global(ul) {
		list-style: disc;
	}

	.md :global(ol) {
		list-style: decimal;
	}

	.md :global(li + li) {
		margin-top: var(--space-1);
	}

	.md :global(li::marker) {
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.md :global(strong),
	.md :global(b) {
		font-weight: 600;
	}

	.md :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: min(var(--gh-code-size, 13px), 0.93em);
		padding: 0.125rem 0.25rem;
		border-radius: var(--radius-xs);
		background: var(--fill-quiet);
	}

	.md :global(pre) {
		margin: var(--space-3) 0;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-sunken);
		overflow-x: auto;
	}

	.md :global(pre code) {
		padding: 0;
		border-radius: 0;
		background: none;
		font-size: var(--gh-code-size, 13px);
		line-height: round(up, calc(var(--gh-code-size, 13px) * 1.5), 0.25rem);
	}

	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: var(--space-4) 0 var(--space-2);
		font-size: inherit;
		line-height: inherit;
		font-weight: 600;
		color: var(--text-default);
	}

	.md :global(a) {
		color: var(--text-link);
		text-decoration: underline;
		text-decoration-color: color-mix(in oklab, currentColor 35%, transparent);
		text-underline-offset: 0.2em;
	}

	.md :global(a:hover) {
		text-decoration-color: currentColor;
	}

	.md :global(blockquote) {
		margin: var(--space-3) 0;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-muted);
	}

	.md :global(table) {
		margin: var(--space-3) 0;
		border-collapse: collapse;
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
	}

	.md :global(th),
	.md :global(td) {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border-default);
		text-align: left;
	}

	.md :global(th) {
		font-weight: 600;
	}

	.md :global(hr) {
		margin: var(--space-4) 0;
		border: none;
		border-top: 1px solid var(--border-default);
	}
</style>
