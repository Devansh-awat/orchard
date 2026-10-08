<script lang="ts">
	import { ArrowDown, Loader2 } from 'lucide-svelte';
	import { Skeleton } from '$lib/components/ui';
	import { fade } from '$lib/utils/transitions';
	import { commentTime, type ChatSessionStore } from './session-store.svelte';
	import Entry from './parts/Entry.svelte';
	import HumanMessage from './parts/HumanMessage.svelte';
	import ToolGroup from './parts/ToolGroup.svelte';

	let { store }: { store: ChatSessionStore } = $props();

	let scrollEl = $state<HTMLDivElement | undefined>(undefined);
	let atBottom = $state(true);
	let stick = true;

	const thread = $derived(store.active);
	const loading = $derived(!store.settled || (thread?.loading ?? false));
	const lastIndex = $derived((thread?.entries.length ?? 0) - 1);
	const reverted = $derived(thread?.revertedMessageID ?? null);
	const liveGroup = $derived.by(() => {
		if (!store.busy) return null;
		const feed = store.feed;
		for (let i = feed.length - 1; i >= 0; i -= 1) {
			const item = feed[i];
			if (item.type === 'entry' && item.entry.kind === 'thinking') continue;
			return item.type === 'tools' ? item.key : null;
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

	function toBottom(smooth = false) {
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}

	function onScroll() {
		if (!scrollEl) return;
		stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 48;
		atBottom = stick;
	}

	function jump() {
		stick = true;
		atBottom = true;
		toBottom(true);
	}

	function follow(el: HTMLElement) {
		const ro = new ResizeObserver(() => {
			if (stick) toBottom();
		});
		ro.observe(el);
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
		<div class="tx-col" {@attach follow}>
			{#if loading}
				<div class="tx-skeletons" aria-hidden="true">
					<div class="tx-skel-user"><Skeleton height="2.25rem" width="40%" /></div>
					<Skeleton height="0.75rem" width="82%" />
					<Skeleton height="0.75rem" width="68%" />
					<Skeleton height="0.75rem" width="34%" />
				</div>
			{:else if store.feed.length === 0}
				<div class="tx-empty">
					<p class="tx-empty-title">Ask the agent to build something.</p>
					<p class="tx-empty-sub">
						It works directly in this sandbox's files, and every session stays on its disk.
					</p>
				</div>
			{:else}
				{#each store.feed as item (item.key)}
					{#if item.type === 'prompt'}
						<HumanMessage
							text={item.entry.text}
							attachments={item.entry.attachments ?? []}
							author={item.author}
							own={item.own}
							grouped={item.grouped}
							messageID={item.entry.messageID ?? null}
							reverted={!!item.entry.messageID && item.entry.messageID === reverted}
							actions={!store.busy}
							locked={store.revertBusy !== null}
							onfork={(id) => store.fork(id)}
							onrevert={(id) => store.revert(id)}
							onunrevert={() => store.unrevert()}
						/>
					{:else if item.type === 'comment'}
						<HumanMessage
							variant="comment"
							text={item.comment.body}
							author={item.comment.author}
							own={item.own}
							grouped={item.grouped}
							time={commentTime(item.comment)}
						/>
					{:else if item.type === 'tools'}
						<ToolGroup items={item.items} {store} live={item.key === liveGroup} />
					{:else}
						<Entry
							entry={item.entry}
							{store}
							index={item.index}
							live={store.busy &&
								item.index === lastIndex &&
								item.entry.kind === 'thinking' &&
								!item.entry.done}
						/>
					{/if}
				{/each}
				{#if store.busy}
					<div class="tx-working">
						<Loader2 class="h-3.5 w-3.5 animate-spin" data-motion="progress" />
						{#if thread?.stopping}
							Stopping
						{:else if background > 0}
							Waiting for {background} background {background === 1 ? 'task' : 'tasks'}
						{:else}
							Working
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</div>
	{#if !atBottom}
		<button type="button" class="tx-jump" transition:fade onclick={jump}>
			<ArrowDown class="h-3 w-3" /> Jump to latest
		</button>
	{/if}
</div>

<style>
	.tx {
		position: relative;
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
		padding: var(--space-5) var(--space-8) var(--space-6);
	}

	.tx-col {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		width: 100%;
		max-width: 52.5rem;
		margin: auto 0 0;
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
		gap: 0.25rem;
		padding-bottom: var(--space-4);
	}

	.tx-empty-title {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		color: var(--text-muted);
	}

	.tx-empty-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
	}

	.tx-working {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.tx-jump {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-overlay);
		box-shadow: var(--elev-2);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		cursor: pointer;
	}
</style>
