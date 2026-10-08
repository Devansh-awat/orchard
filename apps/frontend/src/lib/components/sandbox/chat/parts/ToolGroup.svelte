<script lang="ts">
	import { ChevronRight, Layers, Loader2 } from 'lucide-svelte';
	import { StatusBadge, statusMeta } from '$lib/components/ui';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ChatSessionStore, FeedEntry } from '../session-store.svelte';
	import { EDIT_TOOLS } from '../format';
	import Entry from './Entry.svelte';

	let {
		items,
		store,
		live = false
	}: { items: FeedEntry[]; store: ChatSessionStore; live?: boolean } = $props();

	let userOpen = $state<boolean | null>(null);
	const open = $derived(userOpen ?? live);

	const SEARCH = new Set(['Grep', 'Glob', 'List', 'WebSearch', 'WebFetch']);

	function plural(n: number, one: string, many: string) {
		return `${n} ${n === 1 ? one : many}`;
	}

	const summary = $derived.by(() => {
		let commands = 0;
		let searches = 0;
		let other = 0;
		let add = 0;
		let del = 0;
		let failed = 0;
		let running = false;
		const edited = new Set<string>();
		const read = new Set<string>();
		for (const { entry } of items) {
			if (entry.kind !== 'tool') continue;
			if (entry.failed) failed += 1;
			if (entry.status === 'running' || entry.status === 'pending') running = true;
			add += entry.diff?.add ?? 0;
			del += entry.diff?.del ?? 0;
			if (entry.name === 'Bash') commands += 1;
			else if (EDIT_TOOLS.has(entry.name) || entry.name === 'Patch') {
				edited.add(entry.title ?? entry.summary);
			} else if (entry.name === 'Read') read.add(entry.title ?? entry.summary);
			else if (SEARCH.has(entry.name)) searches += 1;
			else other += 1;
		}
		const parts = [
			commands ? `ran ${plural(commands, 'command', 'commands')}` : '',
			edited.size ? `edited ${plural(edited.size, 'file', 'files')}` : '',
			read.size ? `read ${plural(read.size, 'file', 'files')}` : '',
			searches ? `searched ${plural(searches, 'time', 'times')}` : '',
			other ? `used ${plural(other, 'tool', 'tools')}` : ''
		].filter(Boolean);
		const label = parts.join(', ');
		return {
			label: label.charAt(0).toUpperCase() + label.slice(1),
			add,
			del,
			failed,
			running
		};
	});

	const failedMeta = $derived(statusMeta('error', `${summary.failed} failed`));
</script>

<div class="group">
	<button type="button" class="group-row" aria-expanded={open} onclick={() => (userOpen = !open)}>
		<span class="group-icon" aria-hidden="true">
			{#if summary.running}
				<Loader2 class="h-3.5 w-3.5 animate-spin" data-motion="progress" />
			{:else}
				<Layers class="h-3.5 w-3.5" />
			{/if}
		</span>
		<span class="group-label">{summary.label}</span>
		{#if summary.add > 0 || summary.del > 0}
			<span class="group-diff">
				{#if summary.add > 0}<span class="diff-add">+{summary.add}</span>{/if}
				{#if summary.del > 0}<span class="diff-del">−{summary.del}</span>{/if}
			</span>
		{/if}
		{#if summary.failed > 0}<StatusBadge meta={failedMeta} />{/if}
		<span class="group-chev" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
			<ChevronRight class="h-3 w-3" />
		</span>
	</button>
	{#if open}
		<div class="group-body" transition:slide>
			{#each items as item (item.entry.key)}
				<Entry entry={item.entry} {store} index={item.index} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.group {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.group-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: fit-content;
		max-width: 100%;
		min-width: 0;
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

	.group-row:hover {
		background: var(--bg-hover);
	}

	.group-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.group-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: var(--text-default);
	}

	.group-diff {
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

	.group-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.group-body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.125rem 0 0.25rem 1.5rem;
	}
</style>
