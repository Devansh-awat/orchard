<script lang="ts">
	import { Check, Copy, Ellipsis, GitFork, Undo2 } from 'lucide-svelte';
	import { Menu, MenuItem } from '@orchard/graft-ui';
	import type { ResultEntry } from '../session-store.svelte';
	import { fmtClock, fmtCost, fmtDuration } from '../format';

	let {
		entry,
		oncopy,
		promptId = null,
		locked = false,
		onfork = undefined,
		onrevert = undefined,
		showDuration = true
	}: {
		entry: ResultEntry;
		oncopy: () => Promise<void> | void;
		promptId?: string | null;
		locked?: boolean;
		onfork?: (messageID: string) => void;
		onrevert?: (messageID: string) => void;
		showDuration?: boolean;
	} = $props();

	const MAX_FILES = 3;

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const meta = $derived(
		[
			entry.time ? fmtClock(entry.time) : '',
			showDuration && entry.duration !== null ? fmtDuration(entry.duration) : ''
		]
			.filter(Boolean)
			.join(' · ')
	);
	const shown = $derived(entry.files.slice(0, MAX_FILES));
	const hidden = $derived(entry.files.slice(MAX_FILES));

	async function copy() {
		await oncopy();
		copied = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="foot" data-align="content">
	{#if meta}
		<span class="foot-meta" title={entry.cost !== null ? fmtCost(entry.cost) : undefined}
			>{meta}</span
		>
	{/if}
	<span class="foot-actions">
		<button
			type="button"
			class="foot-btn"
			aria-label={copied ? 'Copied' : 'Copy this reply'}
			title="Copy this reply"
			onclick={copy}
		>
			{#if copied}<Check size={14} strokeWidth={1.75} />{:else}<Copy
					size={14}
					strokeWidth={1.75}
				/>{/if}
		</button>
		<Menu placement="bottom-start">
			{#snippet trigger(props, open)}
				<button
					type="button"
					class="foot-btn"
					class:foot-btn--open={open}
					aria-label="More actions for this reply"
					title="More"
					{...props}
				>
					<Ellipsis size={14} strokeWidth={1.75} />
				</button>
			{/snippet}
			<MenuItem onclick={copy}><Copy class="h-3.5 w-3.5" /> Copy reply</MenuItem>
			{#if promptId && onfork}
				{@const id = promptId}
				<MenuItem disabled={locked} onclick={() => onfork(id)}>
					<GitFork class="h-3.5 w-3.5" /> Fork to new chat
				</MenuItem>
			{/if}
			{#if promptId && onrevert}
				{@const id = promptId}
				<MenuItem disabled={locked} onclick={() => onrevert(id)}>
					<Undo2 class="h-3.5 w-3.5" /> Undo this turn
				</MenuItem>
			{/if}
			{#if entry.cost !== null}
				<div class="foot-cost">Cost {fmtCost(entry.cost)}</div>
			{/if}
		</Menu>
	</span>
	{#if entry.files.length > 0}
		<span class="foot-files">
			{#each shown as file (file.path)}
				<span class="foot-file" title={file.path}>
					<span class="foot-file-name">{file.name}</span>
					{#if file.add > 0}<span class="diff-add">+{file.add}</span>{/if}
					{#if file.del > 0}<span class="diff-del">−{file.del}</span>{/if}
				</span>
			{/each}
			{#if hidden.length > 0}
				<span class="foot-file" title={hidden.map((f) => f.path).join('\n')}>+{hidden.length}</span>
			{/if}
		</span>
	{/if}
</div>

<style>
	.foot {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		min-width: 0;
		min-height: 1.5rem;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.foot-meta {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.foot-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		margin-left: calc(-1 * var(--space-1));
	}

	.foot-meta + .foot-actions {
		margin-left: 0;
	}

	.foot-btn {
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

	.foot-btn:hover,
	.foot-btn--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.foot-cost {
		padding: var(--space-2) var(--space-3) var(--space-1);
		font-size: var(--text-caption);
		line-height: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.foot-files {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		min-width: 0;
	}

	.foot-file {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		max-width: 14rem;
		height: 1.25rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.foot-file-name {
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
