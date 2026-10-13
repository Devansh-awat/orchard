<script lang="ts">
	import { ChevronsDownUp, FilePlus, Search, X } from 'lucide-svelte';
	import { getGreenhouseApp } from './app.svelte';
	import ChangesPane from './ChangesPane.svelte';
	import ChecksPane from './ChecksPane.svelte';
	import Dock from './Dock.svelte';
	import FileTree from './FileTree.svelte';
	import PrButton from './PrButton.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import ReviewPane from './ReviewPane.svelte';
	import { DOCK } from './layout.svelte';
	import { VIEWER_ONLY, type MachineWorkspace } from './workspace.svelte';
	import type { RightTab } from './types';

	let {
		ws,
		showDock = true,
		header = false
	}: { ws: MachineWorkspace; showDock?: boolean; header?: boolean } = $props();

	const app = getGreenhouseApp();
	const session = $derived(ws.session);
	const changeCount = $derived(session ? (ws.changes.get(session.id)?.files.length ?? 0) : 0);
	const reviewCount = $derived(
		session ? ws.comments.items.filter((c) => c.path.includes(session.worktreePath)).length : 0
	);

	let tab = $state<RightTab>('changes');
	let searching = $state(false);
	let filter = $state('');
	let searchField = $state<HTMLInputElement | null>(null);
	let tree = $state<FileTree | null>(null);
	let dock = $state<Dock | null>(null);
	let stack = $state<HTMLDivElement | null>(null);
	let startRatio = 0;

	function pick(next: RightTab) {
		tab = next;
		if (next !== 'files') searching = false;
	}

	function search() {
		tab = 'files';
		searching = !searching;
		if (!searching) filter = '';
	}

	function newFile() {
		tab = 'files';
		queueMicrotask(() => tree?.create('file'));
	}

	function dockHeight(): number {
		return stack?.clientHeight ?? 1;
	}

	export function showTab(next: RightTab) {
		pick(next);
	}

	export function findFile() {
		tab = 'files';
		if (searching) searchField?.focus();
		else searching = true;
	}

	export function terminal() {
		dock?.focusTerminal();
	}

	export function newTerminal() {
		dock?.newTerminal();
	}
</script>

<aside class="right" aria-label="Session panel">
	{#if header}
		<div class="bar" data-align="topbar">
			<span class="grow"></span>
			<PrButton {ws} />
		</div>
	{/if}

	<div class="stack" bind:this={stack}>
		<div
			data-tour="changes"
			class="top"
			style={showDock && app.layout.dockOpen
				? `flex: 0 0 ${(1 - app.layout.dock) * 100}%`
				: 'flex: 1 1 auto'}
		>
			<div class="gh-tabs" data-align="tabstrip">
				<div class="tab-list" role="tablist" aria-label="Session panel">
					<button
						type="button"
						role="tab"
						class="gh-tab"
						aria-selected={tab === 'files'}
						onclick={() => pick('files')}
					>
						<span class="gh-tl" data-label="All files" data-align="right-edge">All files</span>
					</button>
					<button
						type="button"
						role="tab"
						class="gh-tab"
						aria-selected={tab === 'changes'}
						onclick={() => pick('changes')}
					>
						<span class="gh-tl" data-label="Changes" data-align="tab-label">Changes</span>
						{#if changeCount > 0}<span class="gh-num count">{changeCount}</span>{/if}
					</button>
					<button
						type="button"
						role="tab"
						class="gh-tab"
						aria-selected={tab === 'checks'}
						onclick={() => pick('checks')}
					>
						<span class="gh-tl" data-label="Checks" data-align="tab-label">Checks</span>
					</button>
					<button
						type="button"
						role="tab"
						class="gh-tab"
						aria-selected={tab === 'review'}
						title="Diff comments to send to the agent"
						onclick={() => pick('review')}
					>
						<span class="gh-tl" data-label="Review" data-align="tab-label">Review</span>
						{#if reviewCount > 0}<span class="gh-num count">{reviewCount}</span>{/if}
					</button>
				</div>
				<span class="grow"></span>
				{#if tab === 'files'}
					<button
						type="button"
						class="gh-ibtn"
						aria-label="Collapse all"
						title="Collapse all folders"
						onclick={() => tree?.collapseAll()}
					>
						<ChevronsDownUp size={16} strokeWidth={1.75} />
					</button>
				{/if}
				<button
					type="button"
					class="gh-ibtn"
					aria-label="Search files"
					title="Search files"
					aria-pressed={searching}
					onclick={search}
				>
					<Search size={16} strokeWidth={1.75} />
				</button>
				<button
					type="button"
					class="gh-ibtn"
					aria-label="New file"
					title={ws.canEdit ? 'New file' : VIEWER_ONLY}
					disabled={!ws.canEdit || !session}
					onclick={newFile}
				>
					<FilePlus size={16} strokeWidth={1.75} />
				</button>
			</div>

			{#if searching && tab === 'files'}
				<div class="search">
					<Search size={16} strokeWidth={1.75} />
					<input
						class="search-field"
						bind:this={searchField}
						bind:value={filter}
						placeholder="Find a file"
						aria-label="Find a file"
						onkeydown={(e) => e.key === 'Escape' && search()}
						{@attach (node: HTMLInputElement) => node.focus()}
					/>
					<button
						type="button"
						class="gh-ibtn"
						aria-label="Close search"
						title="Close search (Esc)"
						onclick={search}
					>
						<X size={16} strokeWidth={1.75} />
					</button>
				</div>
			{/if}

			<div class="body">
				{#if !session}
					<p class="note">Pick a session to see its files and changes.</p>
				{:else if tab === 'files'}
					<FileTree
						bind:this={tree}
						{ws}
						{session}
						{filter}
						onterminal={() => dock?.focusTerminal()}
					/>
				{:else if tab === 'changes'}
					<ChangesPane {ws} {session} />
				{:else if tab === 'checks'}
					<ChecksPane {ws} {session} />
				{:else}
					<ReviewPane {ws} {session} />
				{/if}
			</div>
		</div>

		{#if showDock}
			<div class="dock" class:dock--closed={!app.layout.dockOpen}>
				{#if app.layout.dockOpen}
					<ResizeHandle
						orientation="horizontal"
						label="Resize terminal dock"
						value={app.layout.dock * 100}
						min={DOCK.min * 100}
						max={DOCK.max * 100}
						active={app.layout.dragging === 'dock'}
						onstart={() => {
							startRatio = app.layout.dock;
							app.layout.dragging = 'dock';
						}}
						ondrag={(delta) => app.layout.setDock(startRatio - delta / dockHeight())}
						onend={() => {
							app.layout.dragging = null;
							app.layout.save();
						}}
						onnudge={(delta) => {
							app.layout.setDock(app.layout.dock - delta / dockHeight());
							app.layout.save();
						}}
						onreset={() => app.layout.reset('dock')}
					/>
				{/if}
				<Dock bind:this={dock} {ws} {session} />
			</div>
		{/if}
	</div>
</aside>

<style>
	.right {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		background: var(--gh-panel);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-titlebar);
		padding: 0 calc(var(--gh-edge) - var(--gh-ibtn-inset)) 0 var(--gh-edge);
		border-bottom: 1px solid var(--gh-line);
	}

	.grow {
		flex: 1;
	}

	.tab-list {
		display: flex;
		align-items: stretch;
		flex: 0 1 auto;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tab-list::-webkit-scrollbar {
		display: none;
	}

	.stack {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.top {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.count {
		color: var(--gh-faint);
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-row);
		padding: 0 calc(var(--gh-edge) - var(--gh-ibtn-inset)) 0 var(--gh-edge);
		border-bottom: 1px solid var(--gh-line-soft);
		color: var(--gh-faint);
	}

	.search-field {
		flex: 1;
		min-width: 0;
		height: 1.5rem;
		background: transparent;
		color: var(--gh-text);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		outline: none;
	}

	.search-field::placeholder {
		color: var(--gh-faint);
	}

	.body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.note {
		margin: 0;
		padding: var(--gh-edge);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.dock {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
		border-top: 1px solid var(--gh-line);
	}

	.dock--closed {
		flex: none;
	}
</style>
