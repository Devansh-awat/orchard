<script lang="ts">
	import { untrack } from 'svelte';
	import { greenhousePrefs } from '$lib/components/greenhouse/prefs.svelte';
	import type { ToolEntry } from '../session-store.svelte';
	import { pretty, toolIcon } from '../format';
	import { isRunning, stepLabel } from '../steps';
	import StepRow from './StepRow.svelte';

	let { entry, nested = false }: { entry: ToolEntry; nested?: boolean } = $props();

	const open = $derived(entry.expanded ?? greenhousePrefs.values.expandTools);
	let seen: boolean | undefined;
	$effect(() => {
		const next = greenhousePrefs.values.expandTools;
		if (seen !== undefined && seen !== next) untrack(() => (entry.expanded = null));
		seen = next;
	});
	const running = $derived(isRunning(entry.status));
	const label = $derived(stepLabel(entry));
	const Icon = $derived(toolIcon(entry.name));
	const lines = $derived.by(() => {
		if (!open) return null;
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
		if (!open || entry.name !== 'Bash') return null;
		const input = entry.input as { command?: unknown } | null;
		return typeof input?.command === 'string' ? input.command : null;
	});
	const changed = $derived(!!entry.diff && (entry.diff.add > 0 || entry.diff.del > 0));
</script>

<StepRow
	title={label.title}
	arg={label.arg}
	hint={entry.title ?? undefined}
	{running}
	failed={entry.failed}
	{nested}
	expanded={open}
	ontoggle={() => (entry.expanded = !open)}
>
	{#snippet icon()}<Icon size={16} strokeWidth={1.75} />{/snippet}
	{#snippet trailing()}
		{#if changed && entry.diff}
			<span class="tool-diff">
				{#if entry.diff.add > 0}<span class="diff-add">+{entry.diff.add}</span>{/if}
				{#if entry.diff.del > 0}<span class="diff-del">−{entry.diff.del}</span>{/if}
			</span>
		{/if}
	{/snippet}
	<div class="detail">
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
</StepRow>

<style>
	.tool-diff {
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

	.detail {
		display: flex;
		flex-direction: column;
		margin-top: var(--space-1);
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
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: var(--gh-code-size, 13px);
		line-height: round(up, calc(var(--gh-code-size, 13px) * 1.5), 0.25rem);
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
</style>
