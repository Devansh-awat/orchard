<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { FileCode, History, MessageSquare } from 'lucide-svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { themeStore } from '$lib/stores';
	import {
		DiffComments,
		EditorWorkspace,
		MonacoDiff,
		MonacoEditor,
		TabStrip,
		languageLabel,
		type DiffLayout,
		type RemoteCursor,
		type RemoteDraftComment,
		type StripTab
	} from '$lib/components/sandbox/editor';
	import { ROOT, SAMPLES, memoryFs } from './samples';

	let { data } = $props();

	const fs = memoryFs();
	const workspace = new EditorWorkspace(fs);
	const comments = new DiffComments();
	const me = { id: 'user-seb', name: 'Seb' };
	const SERVER = `${ROOT}/src/server.ts`;

	let view = $state<string>(data.view);
	let scheme = $state<string>(data.theme ?? 'light');
	let layout = $state<DiffLayout>('split');
	let cursor = $state({ line: 1, col: 1 });
	let tick = $state(0);
	let chatActive = $state(false);
	const CHAT = 'chat:fix-limits';
	let timer: ReturnType<typeof setInterval> | null = null;

	const files = Object.keys(SAMPLES);
	const active = $derived(workspace.active);
	const activePath = $derived(active?.path ?? SERVER);
	const prompt = $derived(comments.toPrompt({ root: ROOT }));
	const stripTabs = $derived<StripTab[]>([
		{ id: CHAT, title: 'Cap order queries', icon: MessageSquare, closable: false },
		...workspace.documents.map((doc) => ({
			id: doc.uri,
			title: doc.name,
			tooltip: doc.path,
			icon: FileCode,
			dirty: doc.dirty
		}))
	]);
	const stripActive = $derived(chatActive ? CHAT : workspace.activeUri);

	function selectTab(id: string) {
		chatActive = id === CHAT;
		if (!chatActive) workspace.activate(id);
	}

	function closeTab(id: string) {
		workspace.close(id, { force: true });
	}

	function reorderTab(from: number, to: number) {
		if (from === 0 || to === 0) return;
		workspace.move(from - 1, to - 1);
	}

	const remoteCursors = $derived<RemoteCursor[]>([
		{
			userId: 'user-alex',
			name: 'Alex',
			colorVar: '--hue-blue',
			path: SERVER,
			line: 13,
			col: 9 + (tick % 24),
			selection: { startLine: 13, startCol: 8, endLine: 13, endCol: 9 + (tick % 24) }
		},
		{
			userId: 'user-sam',
			name: 'Sam',
			colorVar: '--hue-emerald',
			path: SERVER,
			line: 20,
			col: 18
		}
	]);

	const remoteDrafts: RemoteDraftComment[] = [
		{
			userId: 'user-alex',
			name: 'Alex',
			colorVar: '--hue-blue',
			path: SERVER,
			side: 'modified',
			line: 15,
			body: 'Should this log at debug? It fires on every request'
		}
	];

	comments.add({
		path: SERVER,
		side: 'modified',
		line: 14,
		body: 'Pass limit through as a query param instead of interpolating, and add a test for the 500 cap.',
		author: me,
		lineText: SAMPLES[SERVER].working.split('\n')[13]
	});

	function setScheme(next: string) {
		themeStore.setMode(next === 'dark' ? 'dark' : 'light');
	}

	onMount(() => {
		for (const path of files) workspace.open(path, { activate: false });
		workspace.activate(data.file ? `${ROOT}/${data.file}` : SERVER);
		if (data.theme) setScheme(data.theme);
		timer = setInterval(() => tick++, 1200);
		(window as unknown as Record<string, unknown>).__editorHarness = { workspace, comments, fs };
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
		workspace.dispose();
	});
</script>

<div class="harness">
	<header class="harness-bar">
		<span class="harness-title">acme-api</span>
		<span class="harness-branch">orchard/order-limits</span>
		<div class="harness-controls">
			<SegmentedControl
				label="View"
				options={[
					{ value: 'editor', label: 'Editor' },
					{ value: 'diff', label: 'Changes' }
				]}
				bind:value={view}
			/>
			<SegmentedControl
				label="Appearance"
				options={[
					{ value: 'light', label: 'Light' },
					{ value: 'dark', label: 'Dark' }
				]}
				bind:value={scheme}
				onchange={setScheme}
			/>
		</div>
	</header>

	<div class="harness-body">
		<nav class="harness-files" aria-label="Files">
			{#each files as path (path)}
				{@const doc = workspace.get(path)}
				<button
					type="button"
					class="harness-file"
					class:harness-file--active={active?.path === path}
					onclick={() => workspace.open(path)}
				>
					<span class="harness-file-name">{path.slice(ROOT.length + 1)}</span>
					{#if doc?.dirty}<span class="harness-file-dirty" aria-label="Unsaved"></span>{/if}
				</button>
			{/each}
		</nav>

		<section class="harness-center">
			{#if view === 'editor'}
				<TabStrip
					tabs={stripTabs}
					active={stripActive}
					onselect={selectTab}
					onclose={closeTab}
					onreorder={reorderTab}
				>
					{#snippet trailing()}
						<button type="button" class="harness-icon" aria-label="History">
							<History size={16} strokeWidth={1.75} />
						</button>
					{/snippet}
				</TabStrip>
				<div class="harness-pane">
					{#if chatActive}
						<p class="harness-chat">The chat transcript renders here.</p>
					{:else if active}
						<MonacoEditor
							{workspace}
							path={active.path}
							{remoteCursors}
							onCursor={(line, col) => (cursor = { line, col })}
						/>
					{/if}
				</div>
			{:else}
				<div class="harness-pane">
					<MonacoDiff
						{workspace}
						path={activePath}
						bind:layout
						{comments}
						author={me}
						{remoteDrafts}
					/>
				</div>
			{/if}
			<footer class="harness-status">
				<span>{active ? languageLabel(active.language) : ''}</span>
				<span>Ln {cursor.line}, Col {cursor.col}</span>
				<span>{workspace.dirtyCount ? `${workspace.dirtyCount} unsaved` : 'All saved'}</span>
				<span class="harness-status-people">Alex, Sam here</span>
			</footer>
		</section>

		<aside class="harness-review">
			<div class="harness-review-head">
				<span class="harness-review-title">
					{comments.count === 1 ? '1 comment' : `${comments.count} comments`}
				</span>
				<Button
					size="sm"
					variant="ghost"
					disabled={!comments.count}
					onclick={() => comments.clear()}
				>
					Clear
				</Button>
			</div>
			<pre class="harness-prompt">{prompt ||
					'Comments you leave on the diff land here as one prompt.'}</pre>
		</aside>
	</div>
</div>

<style>
	.harness {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg-app);
		color: var(--text-default);
	}

	.harness-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 2.75rem;
		padding: 0 0.75rem 0 1rem;
		border-bottom: 1px solid var(--border-default);
		background: var(--bg-surface);
	}

	.harness-title {
		font-size: var(--text-footnote);
		font-weight: 600;
	}

	.harness-branch {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.harness-controls {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.harness-body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr) 20rem;
	}

	.harness-files {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 0.5rem;
		border-right: 1px solid var(--border-default);
		background: var(--bg-surface);
	}

	.harness-file {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.5rem;
		border-radius: var(--radius-xs);
		font-size: var(--text-footnote);
		text-align: left;
		color: var(--text-muted);
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.harness-file:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.harness-file--active {
		color: var(--text-default);
		background: var(--accent-subtle);
	}

	.harness-file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.harness-file-dirty {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 999px;
		background: var(--text-muted);
	}

	.harness-center {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--bg-app);
	}

	.harness-icon {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.harness-icon:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.harness-chat {
		padding: 1.5rem;
		font-size: var(--text-body);
		color: var(--text-muted);
	}

	.harness-pane {
		flex: 1;
		min-height: 0;
	}

	.harness-status {
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 1.5rem;
		padding: 0 0.75rem;
		border-top: 1px solid var(--border-default);
		font-size: var(--text-micro);
		color: var(--text-muted);
		background: var(--bg-sunken);
	}

	.harness-status-people {
		margin-left: auto;
	}

	.harness-review {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-left: 1px solid var(--border-default);
		background: var(--bg-surface);
	}

	.harness-review-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border-default);
	}

	.harness-review-title {
		font-size: var(--text-footnote);
		font-weight: 600;
	}

	.harness-prompt {
		flex: 1;
		overflow: auto;
		margin: 0;
		padding: 0.75rem;
		font-family: var(--font-mono-terminal);
		font-size: var(--text-caption);
		line-height: 1.6;
		white-space: pre-wrap;
		color: var(--text-muted);
	}
</style>
