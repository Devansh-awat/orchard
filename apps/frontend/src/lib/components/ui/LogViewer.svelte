<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Loader2, TriangleAlert, Terminal, ArrowDown } from 'lucide-svelte';
	import type { LogLine } from '$lib/utils/log-sources.svelte';

	let {
		lines,
		loading = false,
		loadingMore = false,
		error = null,
		atStart = false,
		scrolledUp = $bindable(false),
		surface = 'inherit',
		onLoadEarlier = undefined,
		empty = undefined
	}: {
		lines: LogLine[];
		loading?: boolean;
		loadingMore?: boolean;
		error?: string | null;
		atStart?: boolean;
		scrolledUp?: boolean;
		surface?: 'inherit' | 'dark';
		onLoadEarlier?: () => Promise<void> | void;
		empty?: Snippet;
	} = $props();

	let scroller = $state<HTMLDivElement | null>(null);
	let newWhileScrolled = $state(false);
	let prevCount = 0;
	let lastLoadMoreAt = 0;

	$effect(() => {
		const count = lines.length;
		if (count > prevCount) {
			if (scrolledUp) newWhileScrolled = true;
			else if (!loadingMore) requestAnimationFrame(scrollToBottom);
		}
		if (!scrolledUp) newWhileScrolled = false;
		prevCount = count;
	});

	function scrollToBottom() {
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function jumpToLatest() {
		newWhileScrolled = false;
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function handleScroll() {
		const el = scroller;
		if (!el) return;
		scrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 60;
		if (!onLoadEarlier || loadingMore || atStart) return;
		if (el.scrollTop > 80) return;
		const now = Date.now();
		if (now - lastLoadMoreAt < 400) return;
		lastLoadMoreAt = now;
		const prevHeight = el.scrollHeight;
		const prevTop = el.scrollTop;
		await onLoadEarlier();
		requestAnimationFrame(() => {
			const cur = scroller;
			if (!cur) return;
			cur.scrollTop = prevTop + (cur.scrollHeight - prevHeight);
		});
	}
</script>

<div class="lv" class:lv--dark={surface === 'dark'}>
	{#if loading && lines.length === 0}
		<div class="lv-empty">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span>Loading logs...</span>
		</div>
	{:else if lines.length}
		<div class="lv-scroll" bind:this={scroller} onscroll={handleScroll}>
			{#if loadingMore}
				<div class="lv-more"><Loader2 class="h-3 w-3 animate-spin" /> Loading earlier logs…</div>
			{:else if atStart}
				<div class="lv-more lv-more--end">Start of available logs</div>
			{/if}
			{#each lines as line (line.key)}
				<span class="lv-line">
					{#if line.lineNo != null}<span class="lv-no">{line.lineNo}</span>{/if}
					{#if line.level}<span
							class="lv-level status--{line.level === 'warn'
								? 'warning'
								: line.level === 'error'
									? 'error'
									: line.level === 'debug'
										? 'neutral'
										: 'info'}">{line.level}</span
						>{/if}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html line.html}
				</span>
			{/each}
		</div>
		{#if newWhileScrolled}
			<button type="button" class="lv-newlogs" onclick={jumpToLatest}>
				<ArrowDown size={12} /> New logs
			</button>
		{/if}
	{:else if error}
		<div class="lv-empty lv-empty--error">
			<TriangleAlert class="h-4 w-4" />
			<span>{error}</span>
		</div>
	{:else if empty}
		{@render empty()}
	{:else}
		<div class="lv-empty">
			<Terminal size={16} class="h-4 w-4 opacity-30" />
			<span>No output yet</span>
		</div>
	{/if}
</div>

<style>
	.lv {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		line-height: 1.65;
		font-weight: 400;
	}

	.lv--dark {
		background-color: var(--console-bg);
		color: var(--console-text);
		border-radius: var(--radius-md);
		padding: 0.75rem;
	}

	.lv-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		margin: 0;
	}

	.lv-scroll::-webkit-scrollbar {
		width: 6px;
	}

	.lv-scroll::-webkit-scrollbar-track {
		background: transparent;
	}

	.lv-scroll::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.15);
		border-radius: var(--radius-xs);
	}

	.lv-scroll::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.25);
	}

	.lv-line {
		display: block;
		min-height: 1.2em;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.lv-no {
		display: inline-block;
		min-width: 2.5em;
		margin-right: 0.5em;
		text-align: right;
		opacity: 0.35;
		user-select: none;
	}

	.lv-level {
		display: inline-block;
		margin-right: 0.5em;
		padding: 0 0.35em;
		border-radius: var(--radius-xs);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		text-transform: uppercase;
		background-color: color-mix(in srgb, currentColor 12%, transparent);
	}

	.lv-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		opacity: 0.75;
	}

	.lv-more--end {
		opacity: 0.5;
		font-style: italic;
	}

	.lv-newlogs {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--console-edge);
		border-radius: var(--radius-pill);
		background: var(--console-raised);
		color: var(--console-text);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		cursor: pointer;
	}

	.lv-newlogs:hover {
		background: color-mix(in srgb, var(--console-raised) 90%, white);
	}

	.lv-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		opacity: 0.7;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	.lv-empty--error {
		color: var(--status-error);
		opacity: 1;
	}
</style>
