<script lang="ts">
	import { MonacoDiff, MonacoEditor, languageLabel } from '$lib/components/sandbox/editor';
	import type { CenterTab } from './types';
	import type { MachineWorkspace } from './workspace.svelte';

	let {
		ws,
		tab
	}: { ws: MachineWorkspace; tab: Extract<CenterTab, { kind: 'file' } | { kind: 'diff' }> } =
		$props();

	const doc = $derived(ws.editor.get(tab.path));
	const rel = $derived(ws.resolve(tab.path).rel);
	const author = $derived.by(() => {
		const self = ws.host.self();
		return self ? { id: self.id, name: self.name } : undefined;
	});

	let line = $state(1);
	let col = $state(1);
	let saved = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let savedTimer: ReturnType<typeof setTimeout> | null = null;
	let wasSaving = false;

	function cursor(l: number, c: number) {
		line = l;
		col = c;
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			ws.live.presence({ tab: tab.id, file: tab.path, line, col });
		}, 150);
	}

	$effect(() => {
		ws.live.presence({ tab: tab.id, file: tab.path });
		return () => {
			if (timer) clearTimeout(timer);
			timer = null;
		};
	});

	$effect(() => {
		const saving = doc?.saving ?? false;
		const failed = !!doc?.error;
		const finished = wasSaving && !saving && !failed;
		wasSaving = saving;
		if (savedTimer) clearTimeout(savedTimer);
		savedTimer = null;
		saved = finished;
		if (finished) savedTimer = setTimeout(() => (saved = false), 1600);
	});

	$effect(() => () => {
		if (savedTimer) clearTimeout(savedTimer);
	});
</script>

<div class="view">
	<div class="body">
		{#if tab.kind === 'file'}
			<MonacoEditor
				workspace={ws.editor}
				path={tab.path}
				readOnly={!ws.canEdit}
				autofocus
				remoteCursors={ws.remoteCursors}
				onCursor={cursor}
			/>
		{:else}
			<MonacoDiff
				workspace={ws.editor}
				path={tab.path}
				ref="HEAD"
				comments={ws.comments}
				{author}
			/>
		{/if}
	</div>
	<div class="status" data-align="statusbar">
		<span class="path gh-mono" data-align="status-item" title={tab.path}>{rel}</span>
		<span class="grow"></span>
		{#if tab.kind === 'file'}
			{#if doc?.saving}<span data-align="status-item">Saving…</span>{:else if doc?.dirty}<span
					data-align="status-item">Unsaved</span
				>{:else if saved}<span class="saved" data-align="status-item">Saved</span>{/if}
			{#if doc?.error}<span class="err" data-align="status-item">{doc.error}</span>{/if}
			{#if !ws.canEdit}<span data-align="status-item">Read only</span>{/if}
			<span class="gh-num" data-align="status-item">Ln {line}, Col {col}</span>
			<span data-align="status-item">{languageLabel(doc?.language ?? 'plaintext')}</span>
		{:else}
			<span data-align="status-item">Changes against HEAD</span>
			{#if ws.comments.forPath(tab.path).length > 0}
				<span data-align="status-item">{ws.comments.forPath(tab.path).length} comments</span>
			{/if}
		{/if}
	</div>
</div>

<style>
	.view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}

	.body {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.status {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		flex: none;
		height: 1.5rem;
		padding: 0.25rem var(--gh-edge) 0;
		border-top: 1px solid var(--gh-line);
		color: var(--gh-faint);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		white-space: nowrap;
	}

	.path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.grow {
		flex: 1;
	}

	.saved {
		color: var(--gh-muted);
	}

	.err {
		color: var(--gh-text);
		font-weight: 600;
	}
</style>
