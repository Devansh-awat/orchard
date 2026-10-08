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
	let timer: ReturnType<typeof setTimeout> | null = null;

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
</script>

<div class="view">
	<div class="body">
		{#if tab.kind === 'file'}
			<MonacoEditor
				workspace={ws.editor}
				path={tab.path}
				readOnly={!ws.canEdit}
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
	<div class="status">
		<span class="path gh-mono" title={tab.path}>{rel}</span>
		<span class="grow"></span>
		{#if tab.kind === 'file'}
			{#if doc?.saving}<span>Saving…</span>{:else if doc?.dirty}<span>Unsaved</span>{/if}
			{#if doc?.error}<span class="err">{doc.error}</span>{/if}
			{#if !ws.canEdit}<span>Read only</span>{/if}
			<span class="gh-num">Ln {line}, Col {col}</span>
			<span>{languageLabel(doc?.language ?? 'plaintext')}</span>
		{:else}
			<span>Changes against HEAD</span>
			{#if ws.comments.forPath(tab.path).length > 0}
				<span>{ws.comments.forPath(tab.path).length} comments</span>
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
		align-items: center;
		gap: 0.875rem;
		flex: none;
		height: 1.5rem;
		padding: 0 0.75rem;
		border-top: 1px solid var(--gh-line);
		color: var(--gh-faint);
		font-size: var(--gh-caption);
		white-space: nowrap;
	}

	.path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
	}

	.grow {
		flex: 1;
	}

	.err {
		color: var(--status-error);
	}
</style>
