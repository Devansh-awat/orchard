<script lang="ts">
	import { ChevronRight, CircleX, LoaderCircle } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ToolEntry } from '../session-store.svelte';
	import { pretty, toolVerb } from '../format';

	let { entry, nested = false }: { entry: ToolEntry; nested?: boolean } = $props();

	const running = $derived(entry.status === 'running' || entry.status === 'pending');
	const verb = $derived(toolVerb(entry.name, running));
	const Icon = $derived(verb.icon);
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

<div class="tool">
	<button
		type="button"
		class="step"
		data-align={nested ? undefined : 'step'}
		aria-expanded={entry.expanded}
		title={entry.title ?? undefined}
		onclick={() => (entry.expanded = !entry.expanded)}
	>
		<span class="step-glyph" class:step-glyph--failed={entry.failed} aria-hidden="true">
			{#if running}
				<span class="spin" data-motion="progress"
					><LoaderCircle size={16} strokeWidth={1.75} /></span
				>
			{:else if entry.failed}
				<CircleX size={16} strokeWidth={1.75} />
			{:else}
				<Icon size={16} strokeWidth={1.75} />
			{/if}
		</span>
		<span class="step-verb">{verb.verb}</span>
		{#if entry.summary}<span class="step-target">{entry.summary}</span>{/if}
		{#if entry.diff && (entry.diff.add > 0 || entry.diff.del > 0)}
			<span class="step-diff">
				{#if entry.diff.add > 0}<span class="diff-add">+{entry.diff.add}</span>{/if}
				{#if entry.diff.del > 0}<span class="diff-del">−{entry.diff.del}</span>{/if}
			</span>
		{/if}
		{#if entry.failed}<span class="step-failed">Failed</span>{/if}
		<span class="step-chev" {@attach springRotate(() => entry.expanded, { rest: 0, on: 90 })}>
			<ChevronRight size={16} strokeWidth={1.75} />
		</span>
	</button>
	{#if entry.expanded}
		<div class="detail" transition:slide>
			{#if command !== null}
				<pre class="detail-pre detail-pre--cmd">$ {command}</pre>
			{:else if lines}
				<pre class="detail-pre">{#each lines as line, li (li)}<span
							class="detail-line"
							class:diff-add={line.sign === '+'}
							class:diff-del={line.sign === '−'}>{line.sign} {line.text}</span
						>{/each}</pre>
			{:else}
				<pre class="detail-pre">{pretty(entry.input)}</pre>
			{/if}
			{#if entry.output}
				<pre class="detail-pre detail-pre--out">{entry.output}</pre>
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

	.step {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		max-width: 100%;
		width: fit-content;
		min-height: 1.75rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.step:hover {
		color: var(--text-default);
	}

	.step-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		color: var(--text-faint);
	}

	.step-glyph--failed {
		color: var(--status-error);
	}

	.spin {
		display: inline-flex;
		animation: spin 1s linear infinite;
	}

	.step-verb {
		flex-shrink: 0;
	}

	.step-target {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		color: var(--text-muted);
	}

	.step-diff {
		display: inline-flex;
		gap: var(--space-1);
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}

	.step-failed {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--text-default);
	}

	.step-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.step:hover .step-chev,
	.step:focus-visible .step-chev,
	.step[aria-expanded='true'] .step-chev {
		opacity: 1;
	}

	.detail {
		display: flex;
		flex-direction: column;
		margin: var(--space-1) 0 var(--space-2) var(--space-6);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-sunken);
		overflow: hidden;
	}

	.detail-pre {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		max-height: 16rem;
		overflow: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		white-space: pre;
	}

	.detail-line {
		display: block;
	}

	.detail-pre--cmd {
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.detail-pre--out {
		border-top: 1px solid var(--border-default);
		color: var(--text-faint);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
