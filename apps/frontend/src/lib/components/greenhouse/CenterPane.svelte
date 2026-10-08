<script lang="ts">
	import { FileCode, GitCompare, Globe, History, MessageSquare, Plus, Undo2 } from 'lucide-svelte';
	import PopoverPanel from '$lib/components/ui/PopoverPanel.svelte';
	import { TabStrip, type StripTab } from '$lib/components/sandbox/editor';
	import { getGreenhouseApp } from './app.svelte';
	import ChatView from './ChatView.svelte';
	import EditorView from './EditorView.svelte';
	import PreviewView from './PreviewView.svelte';
	import { VIEWER_ONLY, type MachineWorkspace } from './workspace.svelte';
	import type { CenterTab } from './types';

	let { ws }: { ws: MachineWorkspace } = $props();

	const app = getGreenhouseApp();
	const active = $derived(ws.activeTab);

	const ICONS = { chat: MessageSquare, file: FileCode, diff: GitCompare, preview: Globe } as const;

	const strip = $derived<StripTab[]>(
		ws.tabs.map((tab) => ({
			id: tab.id,
			title: tab.title,
			icon: ICONS[tab.kind],
			dirty: tab.kind === 'file' ? ws.editor.isDirty(tab.path) : false,
			closable: tab.kind !== 'chat',
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

<div class="pane">
	<TabStrip
		tabs={strip}
		active={active?.id ?? null}
		label="Session tabs"
		onselect={select}
		onclose={(id) => ws.closeTab(id)}
		onreorder={(from, to) => ws.reorder(from, to)}
	>
		{#snippet trailing()}
			<button
				type="button"
				class="gh-ibtn add"
				aria-label="New chat"
				title={ws.canEdit ? 'New chat' : VIEWER_ONLY}
				disabled={!ws.canEdit || !ws.running}
				onclick={() => ws.newChat()}
			>
				<Plus size={15} strokeWidth={1.75} />
			</button>
			<span class="grow"></span>
			<PopoverPanel bind:open={historyOpen} placement="bottom-end">
				{#snippet trigger(props, isOpen)}
					<button
						{...props}
						type="button"
						class="gh-ibtn"
						aria-label="Checkpoints"
						title="Checkpoints"
						aria-expanded={isOpen}
					>
						<History size={15} strokeWidth={1.75} />
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
							<Undo2 size={13} strokeWidth={1.75} />
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
		<ChatView {ws} visible={active?.kind === 'chat' || !active} />
		{#if isEditor(active)}
			{#key active.id}
				<EditorView {ws} tab={active} />
			{/key}
		{:else if active?.kind === 'preview'}
			{#key active.id}
				<PreviewView {ws} tab={active} />
			{/key}
		{/if}
	</div>
</div>

<style>
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

	.add {
		width: 1.5rem;
		height: 1.5rem;
		margin-left: -0.25rem;
	}

	.grow {
		flex: 1;
	}

	.checkpoints {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 20rem;
	}

	.cp-head {
		margin: 0 0 0.25rem;
		padding: 0 0.375rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.cp {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 1.875rem;
		padding: 0 0.375rem;
		border-radius: var(--radius-xs);
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
		color: var(--gh-faint);
	}

	.cp-empty {
		margin: 0;
		padding: 0.25rem 0.375rem 0.375rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}
</style>
