<script lang="ts">
	import { Check, Copy, Plus, X } from 'lucide-svelte';
	import { StatusDot, statusMeta } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { ChatSession, ChatSessionStore } from './session-store.svelte';
	import { truncate } from './format';

	let { store }: { store: ChatSessionStore } = $props();

	const workingMeta = statusMeta('progress', 'Working', true);

	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	let deleteOpen = $state(false);
	let deleteTarget = $state<ChatSession | null>(null);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	const hasEntries = $derived((store.active?.entries.length ?? 0) > 0);

	function working(id: string): boolean {
		const state = store.activity.get(id);
		return state === 'busy' || state === 'retry' || (store.threads.get(id)?.busy ?? false);
	}

	function commitRename() {
		const id = renamingId;
		renamingId = null;
		if (id) void store.renameSession(id, renameText);
	}

	async function copyTranscript() {
		await navigator.clipboard.writeText(store.transcriptText());
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="tabs-bar">
	<div class="tabs" role="tablist" aria-label="Conversations">
		{#each store.sessions as session (session.id)}
			<div class="tab" class:tab--active={session.id === store.activeId} role="presentation">
				{#if renamingId === session.id}
					<input
						class="tab-rename"
						bind:value={renameText}
						aria-label="Conversation title"
						onkeydown={(e) => {
							if (e.key === 'Enter') commitRename();
							else if (e.key === 'Escape') renamingId = null;
						}}
						onblur={commitRename}
						{@attach (el) => (el as HTMLInputElement).focus()}
					/>
				{:else}
					<button
						type="button"
						class="tab-btn"
						role="tab"
						aria-selected={session.id === store.activeId}
						title={session.title}
						onclick={() => store.selectSession(session.id)}
						ondblclick={() => {
							renamingId = session.id;
							renameText = session.title;
						}}
					>
						{#if working(session.id)}<StatusDot meta={workingMeta} size={6} />{/if}
						{truncate(session.title, 24) || 'Untitled'}
					</button>
					<button
						type="button"
						class="tab-close"
						aria-label={`Delete ${session.title}`}
						disabled={working(session.id)}
						onclick={() => {
							deleteTarget = session;
							deleteOpen = true;
						}}
					>
						<X class="h-3 w-3" />
					</button>
				{/if}
			</div>
		{/each}
	</div>
	<button
		type="button"
		class="icon-btn"
		aria-label="New conversation"
		title="New conversation"
		onclick={() => store.createSession()}
	>
		<Plus class="h-3.5 w-3.5" />
	</button>
	<div class="tabs-right">
		{#if hasEntries}
			<button
				type="button"
				class="icon-btn"
				aria-label="Copy transcript"
				title="Copy transcript"
				onclick={copyTranscript}
			>
				{#if copied}<Check class="h-3 w-3" />{:else}<Copy class="h-3 w-3" />{/if}
			</button>
		{/if}
	</div>
</div>

<ConfirmModal
	bind:open={deleteOpen}
	title="Delete conversation?"
	description={`This deletes ${deleteTarget?.title ?? 'this conversation'} and its transcript from the sandbox.`}
	confirmLabel="Delete"
	onconfirm={() => {
		const target = deleteTarget;
		deleteTarget = null;
		if (target) void store.deleteSession(target.id);
	}}
	oncancel={() => (deleteTarget = null)}
/>

<style>
	.tabs-bar {
		display: flex;
		align-items: stretch;
		gap: var(--space-1);
		flex-shrink: 0;
		height: 2.25rem;
		padding: 0 var(--space-2);
		border-bottom: 1px solid var(--border-default);
	}

	.tabs {
		display: flex;
		align-items: stretch;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tabs::-webkit-scrollbar {
		display: none;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		padding-right: 0.25rem;
	}

	.tab--active {
		border-bottom-color: var(--text-default);
	}

	.tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: none;
		background: none;
		padding: 0 0.125rem 0 var(--space-2);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 400;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		transition: color var(--dur-fast);
	}

	.tab--active .tab-btn {
		font-weight: 500;
	}

	.tab--active .tab-btn,
	.tab-btn:hover {
		color: var(--text-default);
	}

	.tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.tab:hover .tab-close,
	.tab-close:focus-visible {
		opacity: 1;
	}

	.tab-close:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.tab-close:disabled {
		cursor: default;
	}

	.tab-rename {
		width: 9rem;
		align-self: center;
		padding: 0.125rem 0.375rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}

	.tab-rename:focus-visible {
		outline: none;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		align-self: center;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.tabs-right {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		margin-left: auto;
	}
</style>
