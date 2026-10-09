<script lang="ts">
	import type * as Monaco from 'monaco-editor';
	import { onDestroy, onMount, untrack } from 'svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { effectiveAnimation } from '$lib/stores/preferences';
	import { terminalDisplay } from '$lib/stores/terminal-display.svelte';
	import { greenhousePrefs } from '$lib/components/greenhouse/prefs.svelte';
	import { ensureTerminalFont } from '$lib/terminal/font';
	import { activeTarget, mayTakeFocus } from '$lib/utils/focus-routing';
	import { RemoteCursorLayer, type CollabBinding, type RemoteCursor } from './collab';
	import type { MonacoApi } from './load';
	import { baseOptions, lookOptions } from './options';
	import type { EditorSelectionRange } from './types';
	import { useMonacoTheme } from './theme';
	import { toDocumentUri, type EditorWorkspace } from './workspace.svelte';

	let {
		workspace,
		path,
		readOnly = false,
		fontSize = undefined,
		minimap = false,
		autofocus = false,
		collab = undefined,
		remoteCursors = [],
		onCursor = undefined,
		onSelection = undefined,
		onReady = undefined,
		class: klass = ''
	}: {
		workspace: EditorWorkspace;
		path: string;
		readOnly?: boolean;
		fontSize?: number;
		minimap?: boolean;
		autofocus?: boolean;
		collab?: CollabBinding;
		remoteCursors?: readonly RemoteCursor[];
		onCursor?: (line: number, col: number) => void;
		onSelection?: (selection: EditorSelectionRange | null) => void;
		onReady?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: MonacoApi) => void;
		class?: string;
	} = $props();

	let host: HTMLDivElement;
	let editor = $state.raw<Monaco.editor.IStandaloneCodeEditor | null>(null);
	let shown = $state<string | null>(null);
	let failed = $state<string | null>(null);
	let cursors: RemoteCursorLayer | null = null;
	let releaseTheme: (() => void) | null = null;
	let disposed = false;
	let focusedOnce = false;

	const doc = $derived(workspace.get(path));
	const size = $derived(fontSize ?? greenhousePrefs.codeSize);
	const loading = $derived(!editor || !doc || doc.loading);

	$effect(() => {
		const target = path;
		untrack(() => workspace.open(target, { activate: false }));
	});

	function look() {
		return lookOptions({
			fontSize: size,
			motion: $effectiveAnimation,
			cursorStyle: terminalDisplay.cursorStyle,
			cursorBlink: terminalDisplay.cursorBlink
		});
	}

	onMount(() => {
		void (async () => {
			try {
				const monaco = await workspace.ready();
				await ensureTerminalFont(host, size);
				if (disposed) return;
				releaseTheme = useMonacoTheme(monaco, host);
				monaco.editor.remeasureFonts();
				const instance = monaco.editor.create(host, {
					...baseOptions(host),
					...look(),
					model: null,
					readOnly,
					minimap: { enabled: minimap }
				});
				instance.addAction({
					id: 'orchard.save',
					label: 'Save',
					keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
					run: () => {
						if (shown && !readOnly) void workspace.save(shown);
					}
				});
				instance.onDidChangeCursorPosition((e) => {
					onCursor?.(e.position.lineNumber, e.position.column);
				});
				instance.onDidChangeCursorSelection((e) => {
					if (!onSelection) return;
					const sel = e.selection;
					if (sel.isEmpty()) {
						onSelection(null);
						return;
					}
					onSelection({
						startLine: sel.startLineNumber,
						startCol: sel.startColumn,
						endLine: sel.endLineNumber,
						endCol: sel.endColumn,
						text: instance.getModel()?.getValueInRange(sel) ?? ''
					});
				});
				cursors = new RemoteCursorLayer(monaco, instance);
				editor = instance;
				onReady?.(instance, monaco);
			} catch (err) {
				failed = err instanceof Error ? err.message : 'The editor could not load';
			}
		})();
	});

	$effect(() => {
		const instance = editor;
		const current = doc;
		if (!instance || !current || current.loading || !current.model) return;
		const model = current.model;
		untrack(() => {
			if (instance.getModel() === model) return;
			if (shown) workspace.rememberViewState(shown, instance.saveViewState());
			instance.setModel(model);
			if (current.viewState) instance.restoreViewState(current.viewState);
			shown = current.uri;
			if (autofocus && !focusedOnce) {
				focusedOnce = true;
				requestAnimationFrame(() => takeFocus(instance));
			}
		});
	});

	function takeFocus(instance: Monaco.editor.IStandaloneCodeEditor) {
		if (disposed || editor !== instance) return;
		if (!mayTakeFocus(activeTarget(), (el) => el instanceof Node && host.contains(el))) return;
		instance.focus();
	}

	$effect(() => {
		editor?.updateOptions({ ...look(), readOnly, minimap: { enabled: minimap } });
	});

	$effect(() => {
		const instance = editor;
		const binding = collab;
		const current = shown ? workspace.get(shown) : null;
		const model = current?.model;
		if (!instance || !binding || !model) return;
		return untrack(() => binding.bind(model, instance));
	});

	$effect(() => {
		if (!editor || !shown) return;
		const uri = shown;
		const visible = remoteCursors.filter((c) => !c.path || toDocumentUri(c.path) === uri);
		untrack(() => cursors?.update(visible));
	});

	onDestroy(() => {
		disposed = true;
		if (editor && shown) workspace.rememberViewState(shown, editor.saveViewState());
		cursors?.dispose();
		editor?.dispose();
		releaseTheme?.();
	});

	export function focus() {
		editor?.focus();
	}

	export function reveal(line: number, col = 1) {
		if (!editor) return;
		editor.setPosition({ lineNumber: line, column: col });
		editor.revealLineInCenterIfOutsideViewport(line);
		editor.focus();
	}
</script>

<div class="monaco-shell {klass}">
	<div class="monaco-host" class:monaco-host--hidden={loading} bind:this={host}></div>
	{#if failed || doc?.error}
		<div class="monaco-state">
			<p class="monaco-state-title">This file could not be opened</p>
			<p class="monaco-state-detail">{failed ?? doc?.error}</p>
		</div>
	{:else if loading}
		<div class="monaco-state monaco-state--skeleton" aria-busy="true" aria-label="Loading editor">
			{#each [62, 48, 74, 30, 56, 68, 22, 50] as width, i (i)}
				<div class="monaco-skeleton-row">
					<Skeleton width="1.25rem" height="0.625rem" rounded="0.25rem" />
					<Skeleton width="{width}%" height="0.625rem" rounded="0.25rem" />
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.monaco-shell {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: var(--gh-editor, var(--bg-app));
	}

	.monaco-host {
		position: absolute;
		inset: 0;
	}

	.monaco-host--hidden {
		visibility: hidden;
	}

	.monaco-state {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 1rem 1.25rem;
	}

	.monaco-state--skeleton {
		gap: 0.75rem;
		padding-top: 1rem;
	}

	.monaco-skeleton-row {
		display: flex;
		align-items: center;
		gap: 1.25rem;
	}

	.monaco-state-title {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.monaco-state-detail {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
