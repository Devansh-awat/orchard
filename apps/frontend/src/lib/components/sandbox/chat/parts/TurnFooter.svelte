<script lang="ts">
	import { Check, Copy, Ellipsis, FileCode2, GitFork, Undo2 } from 'lucide-svelte';
	import { Menu, MenuItem } from '$lib/components/ui';
	import type { ResultEntry } from '../session-store.svelte';
	import { fmtClock, fmtCost, fmtDuration } from '../format';

	let {
		entry,
		oncopy,
		promptId = null,
		locked = false,
		onfork = undefined,
		onrevert = undefined
	}: {
		entry: ResultEntry;
		oncopy: () => Promise<void> | void;
		promptId?: string | null;
		locked?: boolean;
		onfork?: (messageID: string) => void;
		onrevert?: (messageID: string) => void;
	} = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const meta = $derived(
		[
			entry.duration !== null ? fmtDuration(entry.duration) : '',
			entry.time ? fmtClock(entry.time) : ''
		]
			.filter(Boolean)
			.join(' · ')
	);

	async function copy() {
		await oncopy();
		copied = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="turn">
	{#if meta}
		<span class="turn-meta" title={entry.cost !== null ? fmtCost(entry.cost) : undefined}
			>{meta}</span
		>
	{/if}
	<button
		type="button"
		class="turn-btn"
		aria-label={copied ? 'Copied' : 'Copy this reply'}
		title="Copy this reply"
		onclick={copy}
	>
		{#if copied}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
	</button>
	<Menu placement="bottom-start">
		{#snippet trigger(props, open)}
			<button
				type="button"
				class="turn-btn"
				class:turn-btn--open={open}
				aria-label="More actions for this reply"
				{...props}
			>
				<Ellipsis class="h-3.5 w-3.5" />
			</button>
		{/snippet}
		<MenuItem onclick={copy}><Copy class="h-3.5 w-3.5" /> Copy reply</MenuItem>
		{#if promptId && onfork}
			{@const id = promptId}
			<MenuItem disabled={locked} onclick={() => onfork(id)}>
				<GitFork class="h-3.5 w-3.5" /> Fork from this prompt
			</MenuItem>
		{/if}
		{#if promptId && onrevert}
			{@const id = promptId}
			<MenuItem disabled={locked} onclick={() => onrevert(id)}>
				<Undo2 class="h-3.5 w-3.5" /> Undo this turn
			</MenuItem>
		{/if}
		{#if entry.cost !== null}
			<div class="turn-cost">Cost {fmtCost(entry.cost)}</div>
		{/if}
	</Menu>
	{#each entry.files as file (file.path)}
		<span class="turn-file" title={file.path}>
			<FileCode2 class="h-3 w-3 shrink-0" />
			<span class="turn-file-name">{file.name}</span>
			{#if file.add > 0}<span class="diff-add">+{file.add}</span>{/if}
			{#if file.del > 0}<span class="diff-del">−{file.del}</span>{/if}
		</span>
	{/each}
</div>

<style>
	.turn {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
		min-width: 0;
		margin: 0.375rem 0 0.75rem;
	}

	.turn-meta {
		flex-shrink: 0;
		margin-right: 0.125rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.turn-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.turn-btn:hover,
	.turn-btn--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.turn-cost {
		padding: 0.375rem 0.75rem 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.turn-file {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		max-width: 16rem;
		height: 1.5rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.turn-file-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}
</style>
