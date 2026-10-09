<script lang="ts">
	import {
		FileCode,
		GitCompare,
		Globe,
		History,
		LoaderCircle,
		MessageSquare,
		Plus,
		Undo2
	} from 'lucide-svelte';
	import PopoverPanel from '$lib/components/ui/PopoverPanel.svelte';
	import { Button, Modal } from '$lib/components/ui';
	import { untrack } from 'svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import TabStrip from '$lib/components/sandbox/editor/TabStrip.svelte';
	import type { StripTab } from '$lib/components/sandbox/editor/types';
	import { Lazy } from '$lib/utils/lazy.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import ChatView from './ChatView.svelte';
	import { loadCollabRooms } from './collab.svelte';
	import PreviewView from './PreviewView.svelte';
	import { VIEWER_ONLY, type MachineWorkspace } from './workspace.svelte';
	import type { CenterTab } from './types';

	let { ws }: { ws: MachineWorkspace } = $props();

	const app = getGreenhouseApp();
	const active = $derived(ws.activeTab);

	const editor = new Lazy(() =>
		Promise.all([import('./EditorView.svelte'), loadCollabRooms()]).then(([module]) => module)
	);
	const EditorView = $derived(editor.current);

	$effect(() => {
		if (isEditor(active)) untrack(() => editor.preload());
	});

	const ICONS = { chat: MessageSquare, file: FileCode, diff: GitCompare, preview: Globe } as const;

	const strip = $derived<StripTab[]>(
		ws.tabs.map((tab) => ({
			id: tab.id,
			title: tab.title,
			icon: ICONS[tab.kind],
			dirty: tab.kind === 'file' ? ws.editor.isDirty(tab.path) : false,
			closable: tab.kind !== 'chat' || ws.canEdit,
			tooltip: tab.kind === 'file' || tab.kind === 'diff' ? ws.resolve(tab.path).rel : tab.title
		}))
	);

	type UserEntry = { kind: 'user'; key: string; text: string; time: number; messageID?: string };

	const prompts = $derived(
		(ws.store.active?.entries ?? [])
			.filter((e): e is UserEntry & typeof e => e.kind === 'user' && !!(e as UserEntry).messageID)
			.slice(-12)
			.reverse()
	);

	let historyOpen = $state(false);

	let doomed = $state<{ chatId: string; title: string } | null>(null);

	function close(id: string) {
		const tab = ws.tabs.find((t) => t.id === id);
		if (tab?.kind === 'chat') {
			doomed = { chatId: tab.chatId, title: tab.title };
			return;
		}
		ws.closeTab(id);
	}

	async function confirmDelete() {
		const target = doomed;
		doomed = null;
		if (target) await ws.deleteChat(target.chatId);
	}

	function select(id: string) {
		app.nav.go({ tab: id }, { replace: true });
	}

	function isEditor(
		tab: CenterTab | null
	): tab is Extract<CenterTab, { kind: 'file' } | { kind: 'diff' }> {
		return tab?.kind === 'file' || tab?.kind === 'diff';
	}

	async function revert(messageID: string | undefined) {
		historyOpen = false;
		if (messageID) await ws.store.revert(messageID);
	}
</script>

<div class="pane" data-align="center">
	<TabStrip
		tabs={strip}
		active={active?.id ?? null}
		label="Session tabs"
		onselect={select}
		onclose={close}
		onreorder={(from, to) => ws.reorder(from, to)}
	>
		{#snippet trailing()}
			<button
				type="button"
				class="gh-ibtn add"
				aria-label="New chat"
				title={!ws.canEdit
					? VIEWER_ONLY
					: ws.running
						? 'New chat'
						: `New chat, starts ${ws.machine?.name ?? 'the machine'}`}
				aria-busy={ws.creatingChat || !!ws.pendingChat}
				disabled={!ws.canEdit || ws.creatingChat}
				onclick={() => ws.newChat()}
			>
				{#if ws.creatingChat || ws.pendingChat}
					<span class="animate-spin inline-grid" data-motion="progress"
						><LoaderCircle size={16} strokeWidth={1.75} /></span
					>
				{:else}
					<Plus size={16} strokeWidth={1.75} />
				{/if}
			</button>
			<span class="grow"></span>
			<PopoverPanel bind:open={historyOpen} placement="bottom-end">
				{#snippet trigger(props, isOpen)}
					<button
						{...props}
						type="button"
						class="gh-ibtn"
						aria-label="Checkpoints"
						title="Checkpoints, roll back to an earlier prompt"
						aria-expanded={isOpen}
					>
						<History size={16} strokeWidth={1.75} />
					</button>
				{/snippet}
				<div class="checkpoints">
					<p class="cp-head">Checkpoints</p>
					{#each prompts as entry (entry.key)}
						<button
							type="button"
							class="cp"
							disabled={!ws.canEdit || !!ws.store.revertBusy}
							onclick={() => revert(entry.messageID)}
							title="Undo everything after this prompt"
						>
							<Undo2 size={14} strokeWidth={1.75} />
							<span class="cp-text">{entry.text || 'Attachment'}</span>
							<span class="cp-time">
								{new Date(entry.time).toLocaleTimeString(undefined, {
									hour: 'numeric',
									minute: '2-digit'
								})}
							</span>
						</button>
					{:else}
						<p class="cp-empty">Prompts you send show up here so you can roll back to them.</p>
					{/each}
				</div>
			</PopoverPanel>
		{/snippet}
	</TabStrip>

	<div class="body">
		<div class="slot" data-align-skip>
			<ChatView {ws} visible={active?.kind === 'chat' || !active} />
		</div>
		{#if isEditor(active) && EditorView}
			{#key active.id}
				<EditorView {ws} tab={active} />
			{/key}
		{:else if isEditor(active)}
			<div class="loading">
				<Skeleton height="0.75rem" width="40%" />
				<Skeleton height="0.75rem" width="65%" />
			</div>
		{:else if active?.kind === 'preview'}
			{#key active.id}
				<PreviewView {ws} tab={active} />
			{/key}
		{/if}
	</div>
</div>

<Modal
	open={doomed !== null}
	onclose={() => (doomed = null)}
	title="Delete {doomed?.title ?? 'this chat'}?"
	size="sm"
>
	<p class="doomed">Its messages are gone for good. The code it changed stays.</p>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (doomed = null)}>Cancel</Button>
		<Button variant="danger" onclick={confirmDelete}>Delete chat</Button>
	{/snippet}
</Modal>

<style>
	.doomed {
		margin: 0;
		color: var(--gh-muted);
	}

	.pane {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}

	.body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.slot {
		display: contents;
	}

	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 3rem var(--gh-edge);
	}

	.add {
		align-self: stretch;
		height: auto;
		margin-left: calc(0.75rem - var(--gh-ibtn-inset));
		border-radius: 0;
	}

	.add:hover:not(:disabled) {
		background: none;
	}

	.grow {
		flex: 1;
	}

	.checkpoints {
		display: flex;
		flex-direction: column;
		width: 20rem;
	}

	.cp-head {
		margin: 0;
		padding: 0.25rem 0.5rem 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.cp {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--gh-list-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		text-align: left;
	}

	.cp:hover:not(:disabled) {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.cp-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-text);
	}

	.cp-time {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.cp-empty {
		margin: 0;
		padding: 0.25rem 0.5rem 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}
</style>
