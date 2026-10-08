<script lang="ts">
	import { ChevronRight, Loader2 } from 'lucide-svelte';
	import { StatusBadge, statusMeta } from '$lib/components/ui';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ToolEntry } from '../session-store.svelte';
	import { pretty, toolVerb } from '../format';

	let { entry }: { entry: ToolEntry } = $props();

	const running = $derived(entry.status === 'running' || entry.status === 'pending');
	const verb = $derived(toolVerb(entry.name, running));
	const Icon = $derived(verb.icon);
	const failedMeta = statusMeta('error', 'Failed');
	const lines = $derived.by(() => {
		if (!entry.expanded) return null;
		const input = (entry.input ?? {}) as Record<string, unknown>;
		const split = (value: unknown, sign: '+' | '−') =>
			typeof value === 'string' ? value.split('\n').map((text) => ({ sign, text })) : [];
		if (entry.name === 'Edit' && typeof input.new_string === 'string') {
			return [...split(input.old_string, '−'), ...split(input.new_string, '+')].slice(0, 400);
		}
		if (entry.name === 'Write' && typeof input.content === 'string') {
			return split(input.content, '+').slice(0, 400);
		}
		return null;
	});
	const command = $derived.by(() => {
		if (!entry.expanded || entry.name !== 'Bash') return null;
		const input = entry.input as { command?: unknown } | null;
		return typeof input?.command === 'string' ? input.command : null;
	});
</script>

<div class="tool" class:tool--failed={entry.failed}>
	<button
		type="button"
		class="tool-row"
		aria-expanded={entry.expanded}
		title={entry.title ?? undefined}
		onclick={() => (entry.expanded = !entry.expanded)}
	>
		<span class="tool-icon" aria-hidden="true">
			{#if running}
				<Loader2 class="h-3.5 w-3.5 animate-spin" data-motion="progress" />
			{:else}
				<Icon class="h-3.5 w-3.5" />
			{/if}
		</span>
		<span class="tool-verb">{verb.verb}</span>
		{#if entry.summary}<span class="tool-target">{entry.summary}</span>{/if}
		{#if entry.diff && (entry.diff.add > 0 || entry.diff.del > 0)}
			<span class="tool-diff">
				{#if entry.diff.add > 0}<span class="diff-add">+{entry.diff.add}</span>{/if}
				{#if entry.diff.del > 0}<span class="diff-del">−{entry.diff.del}</span>{/if}
			</span>
		{/if}
		{#if entry.failed}<StatusBadge meta={failedMeta} />{/if}
		<span class="tool-chev" {@attach springRotate(() => entry.expanded, { rest: 0, on: 90 })}>
			<ChevronRight class="h-3 w-3" />
		</span>
	</button>
	{#if entry.expanded}
		<div class="tool-detail" transition:slide>
			{#if command !== null}
				<pre class="tool-pre tool-pre--cmd">$ {command}</pre>
			{:else if lines}
				<pre class="tool-pre">{#each lines as line, li (li)}<span
							class="tool-line"
							class:diff-add={line.sign === '+'}
							class:diff-del={line.sign === '−'}>{line.sign} {line.text}</span
						>{/each}</pre>
			{:else}
				<pre class="tool-pre">{pretty(entry.input)}</pre>
			{/if}
			{#if entry.output}
				<pre class="tool-pre tool-pre--out">{entry.output}</pre>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.tool-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		width: fit-content;
		max-width: 100%;
		padding: 0.1875rem 0.5rem 0.1875rem 0.375rem;
		margin-left: -0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.tool-row:hover {
		background: var(--bg-hover);
	}

	.tool-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.tool-verb {
		flex-shrink: 0;
		font-weight: 500;
		color: var(--text-default);
	}

	.tool--failed .tool-icon,
	.tool--failed .tool-verb {
		color: var(--status-error);
	}

	.tool-target {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.tool-diff {
		display: inline-flex;
		gap: 0.3125rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}

	.tool-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.tool-row:hover .tool-chev,
	.tool-row:focus-visible .tool-chev,
	.tool-row[aria-expanded='true'] .tool-chev {
		opacity: 1;
	}

	.tool-detail {
		display: flex;
		flex-direction: column;
		margin: 0.25rem 0 0.5rem 1.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		overflow: hidden;
	}

	.tool-pre {
		margin: 0;
		padding: 0.5rem 0.75rem;
		max-height: 16rem;
		overflow: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.55;
		color: var(--text-muted);
		white-space: pre;
	}

	.tool-line {
		display: block;
	}

	.tool-pre--cmd {
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tool-pre--out {
		border-top: 1px solid var(--border-default);
		color: var(--text-faint);
	}
</style>
