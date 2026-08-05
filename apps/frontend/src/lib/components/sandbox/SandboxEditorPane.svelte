<script lang="ts">
	import { untrack } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { Loader2, Save, X } from 'lucide-svelte';
	import { Button, EmptyState } from '$lib/components/ui';
	import { cmExtensions, cmLanguageLabel } from './cm';
	import type { SandboxIde } from './ide.svelte';

	let { ide }: { ide: SandboxIde } = $props();

	let host = $state<HTMLDivElement | undefined>(undefined);
	let view: EditorView | null = null;
	const states = new Map<string, { state: EditorState; readOnly: boolean }>();

	const active = $derived(ide.active);
	const dirty = $derived(active ? ide.isDirty(active) : false);

	function buildState(key: string, path: string, readOnly: boolean, doc: string): EditorState {
		return EditorState.create({
			doc,
			extensions: cmExtensions({
				path,
				readOnly,
				onChange: (value) => ide.setContent(key, value),
				onSave: () => ide.save(key)
			})
		});
	}

	let mountedKey: string | null = null;
	let mountedReadOnly = false;
	let mountedStamp = '';

	$effect(() => {
		if (!host) return;
		view = new EditorView({ parent: host });
		return () => {
			view?.destroy();
			view = null;
			mountedKey = null;
			mountedStamp = '';
		};
	});

	$effect(() => {
		const tab = active;
		const stamp = tab ? `${tab.key}:${tab.rev}:${tab.readOnly}` : '';
		if (!view || stamp === mountedStamp) return;
		if (mountedKey) states.set(mountedKey, { state: view.state, readOnly: mountedReadOnly });
		mountedStamp = stamp;
		mountedKey = tab?.key ?? null;
		mountedReadOnly = tab?.readOnly ?? false;
		if (!tab) {
			view.setState(buildState('', '', true, ''));
			return;
		}
		const doc = untrack(() => tab.content);
		const cached = states.get(tab.key);
		const reuse = cached && cached.readOnly === tab.readOnly && cached.state.doc.toString() === doc;
		const state = reuse ? cached.state : buildState(tab.key, tab.path, tab.readOnly, doc);
		states.set(tab.key, { state, readOnly: tab.readOnly });
		view.setState(state);
		view.focus();
	});

	$effect(() => {
		const keys = new Set(ide.tabs.map((t) => t.key));
		for (const key of states.keys()) if (!keys.has(key)) states.delete(key);
	});
</script>

<div class="ed-root">
	<div class="ed-tabs" role="tablist" aria-label="Open files">
		{#each ide.tabs as tab (tab.key)}
			<div class="ed-tab" class:ed-tab--active={tab.key === ide.activeKey}>
				<button
					type="button"
					role="tab"
					class="ed-tab-btn"
					aria-selected={tab.key === ide.activeKey}
					title={tab.path}
					onclick={() => (ide.activeKey = tab.key)}
				>
					{#if ide.isDirty(tab)}<span class="ed-dot" aria-label="Unsaved"></span>{/if}
					<span class="ed-tab-name">{tab.name}</span>
				</button>
				<button
					type="button"
					class="ed-tab-close"
					aria-label={`Close ${tab.name}`}
					onclick={() => ide.close(tab.key)}
				>
					<X class="h-3 w-3" />
				</button>
			</div>
		{/each}
	</div>

	{#if !active}
		<div class="ed-empty">
			<EmptyState
				title="No file open"
				description="Pick a file in the explorer to read or edit it here."
			/>
		</div>
	{:else}
		{#if active.error}
			<p class="ed-banner ed-banner--error">{active.error}</p>
		{:else if active.truncated}
			<p class="ed-banner">This file was truncated at 500KB. Saving would drop the rest.</p>
		{/if}
		<div class="ed-surface">
			{#if active.loading}
				<div class="ed-loading"><Loader2 class="h-4 w-4 animate-spin" /> Loading file</div>
			{/if}
			<div class="ed-host" bind:this={host} class:ed-host--hidden={active.loading}></div>
		</div>
		<div class="ed-foot">
			<span class="ed-path" title={active.path}>{active.path}</span>
			<span class="ed-lang">{cmLanguageLabel(active.path)}</span>
			{#if active.readOnly}
				<span class="ed-flag">Read only</span>
			{:else}
				<Button
					size="sm"
					variant="ghost"
					disabled={!dirty}
					loading={active.saving}
					onclick={() => ide.save(active.key)}
				>
					<Save class="h-3.5 w-3.5" />
					{dirty ? 'Save' : 'Saved'}
				</Button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.ed-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.ed-tabs {
		display: flex;
		align-items: stretch;
		flex-shrink: 0;
		height: 1.875rem;
		overflow-x: auto;
		border-bottom: 1px solid var(--border-default);
	}

	.ed-tab {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		max-width: 12rem;
		padding-right: 0.25rem;
		border-right: 1px solid var(--border-default);
		transition: background-color var(--dur-fast);
	}

	.ed-tab:hover {
		background: var(--bg-hover);
	}

	.ed-tab--active {
		background: var(--bg-raised);
	}

	.ed-tab-btn {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		min-width: 0;
		height: 100%;
		padding: 0 0.375rem 0 0.625rem;
		border: none;
		background: none;
		cursor: pointer;
	}

	.ed-tab-name {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ed-tab--active .ed-tab-name {
		color: var(--text-default);
	}

	.ed-dot {
		width: 0.3125rem;
		height: 0.3125rem;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
	}

	.ed-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.ed-tab-close:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.ed-empty {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		min-height: 0;
	}

	.ed-banner {
		flex-shrink: 0;
		padding: 0.375rem 0.75rem;
		border-bottom: 1px solid var(--status-warning-border);
		background: var(--status-warning-bg);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-default);
	}

	.ed-banner--error {
		border-bottom-color: var(--status-error-border);
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.ed-surface {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.ed-host {
		height: 100%;
		overflow: hidden;
	}

	.ed-host--hidden {
		visibility: hidden;
	}

	.ed-loading {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		z-index: 1;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.ed-foot {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-shrink: 0;
		height: 1.875rem;
		padding: 0 0.375rem 0 0.75rem;
		border-top: 1px solid var(--border-default);
	}

	.ed-path {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ed-lang {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.ed-flag {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}
</style>
