<script lang="ts">
	import type * as Monaco from 'monaco-editor';
	import { onDestroy, onMount, untrack } from 'svelte';
	import SegmentedControl from '@orchardlabs/graft-ui/components/ui/SegmentedControl.svelte';
	import Skeleton from '@orchardlabs/graft-ui/components/ui/Skeleton.svelte';
	import { effectiveAnimation } from '@orchardlabs/graft-ui/stores/preferences';
	import { terminalDisplay } from '../../../lib/stores/terminal-display.svelte';
	import { greenhousePrefs } from '../../greenhouse/prefs.svelte';
	import { ensureTerminalFont, monoFontFor } from '../../../lib/terminal/font';
	import {
		type DiffComments,
		type CommentAuthor,
		type DiffComment,
		type DiffSide,
		type LocalDraft,
		type RemoteDraftComment
	} from './comments.svelte';
	import type { MonacoApi } from './load';
	import { baseOptions, lookOptions, settleFont } from './options';
	import { useMonacoTheme } from './theme';
	import { DiffThreads, type ThreadState } from './threads.svelte';
	import type { DiffLayout } from './types';
	import { toDocumentUri, toFsPath, type EditorWorkspace } from './workspace.svelte';

	let {
		workspace,
		path,
		ref = 'HEAD',
		layout = $bindable<DiffLayout>('split'),
		showLayoutToggle = true,
		editable = false,
		hideUnchanged = true,
		fontSize = undefined,
		comments = undefined,
		author = undefined,
		remoteDrafts = [],
		oncomment = undefined,
		ondraft = undefined,
		onReady = undefined,
		class: klass = ''
	}: {
		workspace: EditorWorkspace;
		path: string;
		ref?: string;
		layout?: DiffLayout;
		showLayoutToggle?: boolean;
		editable?: boolean;
		hideUnchanged?: boolean;
		fontSize?: number;
		comments?: DiffComments;
		author?: CommentAuthor;
		remoteDrafts?: readonly RemoteDraftComment[];
		oncomment?: (comment: DiffComment) => void;
		ondraft?: (draft: LocalDraft | null) => void;
		onReady?: (editor: Monaco.editor.IStandaloneDiffEditor, monaco: MonacoApi) => void;
		class?: string;
	} = $props();

	const LAYOUTS = [
		{ value: 'split', label: 'Side by side' },
		{ value: 'inline', label: 'Inline' }
	] as const;

	let host: HTMLDivElement;
	let diff = $state.raw<Monaco.editor.IStandaloneDiffEditor | null>(null);
	let attached = $state<string | null>(null);
	let failed = $state<string | null>(null);
	let draft = $state<LocalDraft | null>(null);
	let stats = $state<{ added: number; removed: number } | null>(null);
	let threads: Record<DiffSide, DiffThreads | null> = { original: null, modified: null };
	let releaseTheme: (() => void) | null = null;
	let monacoApi: MonacoApi | null = null;
	let settledFont: string | null = null;
	let disposed = false;
	let sequence = 0;

	const fsPath = $derived(toFsPath(toDocumentUri(path)));
	const doc = $derived(workspace.get(path));
	const size = $derived(fontSize ?? greenhousePrefs.codeSize);
	const loading = $derived(!diff || attached !== `${ref}\u0000${fsPath}`);

	$effect(() => {
		const target = path;
		untrack(() => workspace.open(target, { activate: false }));
	});

	const fontFamily = $derived(greenhousePrefs.monoStack(host ? monoFontFor(host) : ''));

	function look() {
		return lookOptions({
			fontSize: size,
			fontFamily: fontFamily || undefined,
			ligatures: greenhousePrefs.values.ligatures,
			motion: $effectiveAnimation,
			cursorStyle: terminalDisplay.cursorStyle,
			cursorBlink: terminalDisplay.cursorBlink
		});
	}

	function sideEditor(side: DiffSide): Monaco.editor.ICodeEditor | null {
		if (!diff) return null;
		return side === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor();
	}

	function lineText(side: DiffSide, line: number): string | undefined {
		const model = sideEditor(side)?.getModel();
		if (!model || line > model.getLineCount()) return undefined;
		return model.getLineContent(line);
	}

	function setDraft(next: LocalDraft | null) {
		draft = next;
		ondraft?.(next ? { ...next } : null);
	}

	function handlersFor(side: DiffSide) {
		return {
			open: (line: number) => {
				if (!comments) return;
				setDraft({ path: fsPath, side, line, body: '' });
			},
			submit: (line: number, body: string) => {
				if (!comments) return;
				const comment = comments.add({
					path: fsPath,
					side,
					line,
					body,
					author,
					lineText: lineText(side, line)
				});
				setDraft(null);
				oncomment?.(comment);
			},
			cancel: () => setDraft(null),
			reply: (line: number) => setDraft({ path: fsPath, side, line, body: '' }),
			remove: (id: string) => comments?.remove(id),
			draftInput: (line: number, body: string) => {
				if (!draft || draft.line !== line || draft.side !== side) return;
				ondraft?.({ ...draft, body });
			}
		};
	}

	onMount(() => {
		void (async () => {
			try {
				const monaco = await workspace.ready();
				monacoApi = monaco;
				await ensureTerminalFont(host, size);
				if (disposed) return;
				releaseTheme = useMonacoTheme(monaco, host);
				monaco.editor.remeasureFonts();
				const instance = monaco.editor.createDiffEditor(host, {
					...baseOptions(host),
					...look(),
					glyphMargin: true,
					lineDecorationsWidth: 6,
					renderSideBySide: layout === 'split',
					useInlineViewWhenSpaceIsLimited: false,
					enableSplitViewResizing: true,
					renderMarginRevertIcon: false,
					renderIndicators: true,
					renderOverviewRuler: false,
					originalEditable: false,
					readOnly: !editable,
					ignoreTrimWhitespace: false,
					diffWordWrap: 'off',
					hideUnchangedRegions: {
						enabled: hideUnchanged,
						contextLineCount: 3,
						minimumLineCount: 4,
						revealLineCount: 20
					},
					minimap: { enabled: false }
				});
				for (const side of ['original', 'modified'] as const) {
					const editor =
						side === 'original' ? instance.getOriginalEditor() : instance.getModifiedEditor();
					threads[side] = new DiffThreads(monaco, editor, handlersFor(side), () =>
						Boolean(comments)
					);
					editor.addAction({
						id: 'orchard.search',
						label: 'Search and actions',
						keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
						run: () => {
							window.dispatchEvent(new Event('open-quick-search'));
						}
					});
				}
				instance.onDidUpdateDiff(() => {
					let added = 0;
					let removed = 0;
					for (const change of instance.getLineChanges() ?? []) {
						if (change.modifiedEndLineNumber > 0) {
							added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
						}
						if (change.originalEndLineNumber > 0) {
							removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
						}
					}
					stats = { added, removed };
				});
				diff = instance;
				onReady?.(instance, monaco);
			} catch (err) {
				failed = err instanceof Error ? err.message : "The diff couldn't load";
			}
		})();
	});

	$effect(() => {
		const instance = diff;
		const current = doc;
		const target = fsPath;
		const base = ref;
		if (!instance || !current || current.loading || !current.model) return;
		const modified = current.model;
		const token = ++sequence;
		untrack(() => {
			void workspace.original(target, base).then((original) => {
				if (disposed || token !== sequence) return;
				instance.setModel({ original, modified });
				attached = `${base}\u0000${target}`;
			});
		});
	});

	$effect(() => {
		if (!diff || !monacoApi) return;
		const family = fontFamily;
		if (family === settledFont) return;
		settledFont = family;
		void settleFont(
			monacoApi,
			family,
			untrack(() => size)
		);
	});

	$effect(() => {
		diff?.updateOptions({
			...look(),
			renderSideBySide: layout === 'split',
			readOnly: !editable,
			hideUnchangedRegions: { enabled: hideUnchanged }
		});
	});

	const threadState = $derived.by(() => {
		const out: Record<DiffSide, { threads: Map<number, ThreadState>; commented: Set<number> }> = {
			original: { threads: new Map(), commented: new Set() },
			modified: { threads: new Map(), commented: new Set() }
		};
		if (!comments) return out;
		const ensure = (side: DiffSide, line: number) => {
			let state = out[side].threads.get(line);
			if (!state) {
				state = { comments: [], remote: [], drafting: false, draftBody: '', author };
				out[side].threads.set(line, state);
			}
			return state;
		};
		for (const comment of comments.forPath(fsPath)) {
			ensure(comment.side, comment.line).comments.push(comment);
			out[comment.side].commented.add(comment.line);
		}
		for (const remote of remoteDrafts) {
			if (toFsPath(toDocumentUri(remote.path)) !== fsPath) continue;
			ensure(remote.side, remote.line).remote.push(remote);
		}
		if (draft && draft.path === fsPath) {
			const state = ensure(draft.side, draft.line);
			state.drafting = true;
			state.draftBody = draft.body;
		}
		return out;
	});

	$effect(() => {
		const state = threadState;
		if (!diff || loading) return;
		untrack(() => {
			threads.original?.sync(state.original.threads, state.original.commented);
			threads.modified?.sync(state.modified.threads, state.modified.commented);
		});
	});

	onDestroy(() => {
		disposed = true;
		threads.original?.dispose();
		threads.modified?.dispose();
		threads = { original: null, modified: null };
		diff?.setModel(null);
		diff?.dispose();
		releaseTheme?.();
		if (draft) ondraft?.(null);
	});

	export function next() {
		diff?.goToDiff('next');
	}

	export function previous() {
		diff?.goToDiff('previous');
	}
</script>

<div class="diff-shell {klass}">
	{#if showLayoutToggle}
		<div class="diff-bar">
			<span class="diff-name">{doc?.name ?? ''}</span>
			{#if stats && !loading}
				{#if stats.added || stats.removed}
					<span class="diff-stat diff-stat--added">+{stats.added}</span>
					<span class="diff-stat diff-stat--removed">−{stats.removed}</span>
				{:else}
					<span class="diff-stat">No changes against {ref}</span>
				{/if}
			{/if}
			<span class="diff-spacer"></span>
			<SegmentedControl options={LAYOUTS} bind:value={layout} label="Diff layout" />
		</div>
	{/if}
	<div class="diff-body">
		<div class="diff-host" class:diff-host--hidden={loading} bind:this={host}></div>
		{#if failed || doc?.error}
			<div class="diff-state">
				<p class="diff-state-title">This diff couldn't be opened</p>
				<p class="diff-state-detail">{failed ?? doc?.error}</p>
			</div>
		{:else if loading}
			<div class="diff-state diff-state--skeleton" aria-busy="true" aria-label="Loading diff">
				{#each [0, 1] as column (column)}
					<div class="diff-skeleton-column">
						{#each [58, 40, 72, 34, 64, 46] as width, i (i)}
							<Skeleton width="{width}%" height="0.625rem" rounded="0.25rem" />
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.diff-shell {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: var(--gh-editor, var(--bg-app));
	}

	.diff-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem 0.375rem 1rem;
		border-bottom: 1px solid var(--border-default);
	}

	.diff-name {
		font-size: var(--text-footnote);
		font-weight: 600;
	}

	.diff-stat {
		font-family: var(--font-mono-terminal);
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.diff-stat--added {
		color: var(--status-success);
	}

	.diff-stat--removed {
		color: var(--status-error);
	}

	.diff-spacer {
		flex: 1;
	}

	.diff-body {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.diff-host {
		position: absolute;
		inset: 0;
	}

	.diff-host--hidden {
		visibility: hidden;
	}

	.diff-state {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 1rem 1.25rem;
	}

	.diff-state--skeleton {
		flex-direction: row;
		gap: 2rem;
	}

	.diff-skeleton-column {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.diff-state-title {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.diff-state-detail {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
