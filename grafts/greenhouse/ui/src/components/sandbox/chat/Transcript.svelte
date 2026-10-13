<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowDown } from 'lucide-svelte';
	import { Skeleton } from '@orchard/graft-ui';
	import { decorativeMotion } from '@orchard/graft-ui/utils/motion.svelte';
	import { fade } from '../../../lib/utils/transitions';
	import { commentTime, type ChatSessionStore } from './session-store.svelte';
	import { buildChunks, railMarks, type ChunkRow } from './turns';
	import AgentTurn from './parts/AgentTurn.svelte';
	import HumanMessage from './parts/HumanMessage.svelte';
	import MessageRail from './MessageRail.svelte';

	let { store, empty = undefined }: { store: ChatSessionStore; empty?: Snippet } = $props();

	let scrollEl = $state<HTMLDivElement | undefined>(undefined);
	let atBottom = $state(true);
	let inView = $state.raw<ReadonlySet<string>>(new Set());
	let stick = true;
	let measuring = 0;

	const thread = $derived(store.active);
	const loading = $derived(!store.settled || store.selecting || (thread?.loading ?? false));
	const reverted = $derived(thread?.revertedMessageID ?? null);
	const chunks = $derived(buildChunks(store.feed, store.busy));
	const blocks = $derived(chunks.flatMap((c) => c.rows.filter((r) => r.type === 'agent')));
	const liveKey = $derived.by(() => {
		if (!store.busy) return null;
		const last = blocks[blocks.length - 1];
		return last && last.type === 'agent' && !last.result ? last.key : null;
	});
	const latestKey = $derived.by(() => {
		for (let i = blocks.length - 1; i >= 0; i -= 1) {
			const block = blocks[i];
			if (block.type === 'agent' && block.result) return block.key;
		}
		return null;
	});
	const background = $derived.by(() => {
		if (!store.busy || !thread) return 0;
		let count = 0;
		for (let i = thread.entries.length - 1; i >= 0; i -= 1) {
			const entry = thread.entries[i];
			if (entry.kind === 'user') break;
			if (entry.kind === 'agent' && (entry.status === 'running' || entry.status === 'pending')) {
				count += 1;
			}
		}
		return count;
	});
	const liveStatus = $derived(
		thread?.stopping
			? 'Stopping'
			: background > 0
				? `Waiting for ${background} background ${background === 1 ? 'task' : 'tasks'}`
				: null
	);

	const marks = $derived(railMarks(chunks, liveKey));

	function measure() {
		measuring = 0;
		if (!scrollEl) return;
		const view = scrollEl.getBoundingClientRect();
		const seen: string[] = [];
		for (const el of scrollEl.querySelectorAll<HTMLElement>('[data-mark]')) {
			const box = el.getBoundingClientRect();
			if (box.bottom > view.top && box.top < view.bottom && el.dataset.mark) {
				seen.push(el.dataset.mark);
			}
		}
		if (seen.length === inView.size && seen.every((key) => inView.has(key))) return;
		inView = new Set(seen);
	}

	function schedule() {
		if (measuring) return;
		measuring = requestAnimationFrame(measure);
	}

	function jumpTo(key: string) {
		if (!scrollEl) return;
		const el = scrollEl.querySelector<HTMLElement>(`[data-mark="${CSS.escape(key)}"]`);
		if (!el) return;
		const top =
			el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
		stick = false;
		scrollEl.scrollTo({
			top: Math.max(0, top - 16),
			behavior: decorativeMotion() ? 'smooth' : 'auto'
		});
	}

	$effect(() => {
		void marks;
		schedule();
		return () => {
			if (measuring) cancelAnimationFrame(measuring);
			measuring = 0;
		};
	});

	function author(row: ChunkRow): string | null {
		if (row.type === 'prompt') return row.author?.id ?? 'self';
		if (row.type === 'comment') return row.comment.author.id;
		return null;
	}

	function joined(rows: ChunkRow[], ri: number): boolean {
		if (ri === 0) return false;
		const row = rows[ri];
		const prev = rows[ri - 1];
		return row.type !== 'agent' && prev.type === row.type && author(prev) === author(row);
	}

	function toBottom(smooth = false) {
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}

	function onScroll() {
		if (!scrollEl) return;
		stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 48;
		atBottom = stick;
		schedule();
	}

	function jump() {
		stick = true;
		atBottom = true;
		toBottom(true);
	}

	function follow(el: HTMLElement) {
		const ro = new ResizeObserver(() => {
			if (stick) toBottom();
			schedule();
		});
		ro.observe(el);
		const viewport = el.closest('.tx-scroll');
		if (viewport) ro.observe(viewport);
		return () => ro.disconnect();
	}

	$effect(() => {
		void store.sentTick;
		void store.activeId;
		stick = true;
		atBottom = true;
		requestAnimationFrame(() => toBottom());
	});
</script>

<div class="tx">
	<div class="tx-scroll" bind:this={scrollEl} onscroll={onScroll}>
		<div class="chat-col tx-col" {@attach follow}>
			{#if loading}
				<div class="tx-skeletons" aria-hidden="true" data-align="content">
					<div class="tx-skel-user"><Skeleton height="2.5rem" width="40%" /></div>
					<Skeleton height="0.75rem" width="82%" />
					<Skeleton height="0.75rem" width="68%" />
					<Skeleton height="0.75rem" width="34%" />
				</div>
			{:else if chunks.length === 0 && thread?.failed}
				<div class="tx-empty" data-align="content">
					<p class="tx-empty-title">Could not load this chat</p>
					<p class="tx-empty-sub">
						<button type="button" class="tx-retry" onclick={() => store.retryHistory()}
							>Try again</button
						>
					</p>
				</div>
			{:else if chunks.length === 0 && empty}
				{@render empty()}
			{:else if chunks.length === 0}
				<div class="tx-empty" data-align="content">
					<p class="tx-empty-title">Ask the agent to build something.</p>
					<p class="tx-empty-sub">
						It works directly in this sandbox's files, and every session stays on its disk.
					</p>
				</div>
			{:else}
				{#each chunks as chunk (chunk.key)}
					<div class="chunk" data-chunk>
						{#each chunk.rows as row, ri (row.key)}
							{@const together = joined(chunk.rows, ri)}
							<div
								class="row"
								class:row--first={ri === 0}
								class:row--joined={together}
								data-mark={row.key}
							>
								{#if row.type === 'agent'}
									<AgentTurn
										block={row}
										{store}
										live={row.key === liveKey}
										latest={row.key === latestKey}
										status={row.key === liveKey ? liveStatus : null}
									/>
								{:else if row.type === 'prompt'}
									<HumanMessage
										text={row.entry.text}
										attachments={row.entry.attachments ?? []}
										author={row.author}
										own={row.own}
										grouped={together}
										time={row.entry.time}
										messageID={row.entry.messageID ?? null}
										reverted={!!row.entry.messageID && row.entry.messageID === reverted}
										actions={!store.busy}
										locked={store.revertBusy !== null}
										onfork={(id) => store.fork(id)}
										onrevert={(id) => store.revert(id)}
										onunrevert={() => store.unrevert()}
									/>
								{:else}
									<HumanMessage
										variant="comment"
										text={row.comment.body}
										author={row.comment.author}
										own={row.own}
										grouped={together}
										time={commentTime(row.comment)}
									/>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			{/if}
		</div>
	</div>
	{#if marks.length > 1 && !loading}
		<MessageRail {marks} {inView} onjump={jumpTo} />
	{/if}
	{#if !atBottom}
		<button type="button" class="tx-jump" transition:fade onclick={jump}>
			<ArrowDown size={14} strokeWidth={1.75} /> Jump to latest
		</button>
	{/if}
</div>

<style>
	.tx {
		position: relative;
		font-weight: 400;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.tx-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		padding: var(--space-6) 0 var(--space-4);
		scrollbar-gutter: stable both-edges;
	}

	.chat-col {
		--chat-gutter: 2rem;
		--chat-inset: 1rem;
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		padding: 0 calc(var(--chat-gutter) + var(--chat-inset));
	}

	@container chat-pane (min-width: 48rem) {
		.chat-col {
			--chat-inset: 1.5rem;
		}
	}

	.tx-col {
		display: flex;
		flex-direction: column;
		gap: var(--space-8);
		margin: auto auto 0;
	}

	.chunk {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.row {
		min-width: 0;
		margin-top: var(--space-4);
	}

	.row--joined {
		margin-top: var(--space-1);
	}

	.row--first {
		margin-top: 0;
	}

	.tx-skeletons {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.tx-skel-user {
		display: flex;
		justify-content: flex-end;
		margin-bottom: var(--space-2);
	}

	.tx-empty {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.tx-retry {
		color: var(--text-default);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.tx-empty-title {
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		font-weight: 600;
		color: var(--text-default);
	}

	.tx-empty-sub {
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		color: var(--text-muted);
	}

	.tx-jump {
		position: absolute;
		bottom: var(--space-3);
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		height: 1.75rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-overlay);
		box-shadow: var(--elev-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-default);
		cursor: pointer;
	}
</style>
