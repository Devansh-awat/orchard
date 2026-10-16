<script lang="ts">
	import { untrack } from 'svelte';
	import { greenhousePrefs } from '../../../greenhouse/prefs.svelte';
	import { ExternalLink, FileText } from 'lucide-svelte';
	import { Modal } from '@orchardlabs/graft-ui';
	import type { FileOpener, ToolEntry, ToolFile } from '../session-store.svelte';
	import { pretty, toolIcon } from '../format';
	import { isRunning, stepLabel } from '../steps';
	import StepRow from './StepRow.svelte';

	let {
		entry,
		nested = false,
		opener = null
	}: { entry: ToolEntry; nested?: boolean; opener?: FileOpener | null } = $props();

	const READ_TOOL = /^(read|view|read_?file)$/i;
	const readPath = $derived.by(() => {
		if (!READ_TOOL.test(entry.name)) return null;
		const input = (entry.input ?? {}) as Record<string, unknown>;
		const path = input.file_path ?? input.filePath ?? input.path;
		return typeof path === 'string' && path ? path : null;
	});
	const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
	const openable = $derived(!!readPath && !IMAGE_PATH.test(readPath) && !!opener?.can(readPath));
	const images = $derived((entry.files ?? []).filter((f) => f.mime.startsWith('image/')));
	const documents = $derived((entry.files ?? []).filter((f) => !f.mime.startsWith('image/')));
	let zoomed = $state<ToolFile | null>(null);

	function fileName(file: ToolFile): string {
		return (file.name ?? readPath ?? 'file').split('/').pop() || 'file';
	}

	function openDocument(file: ToolFile) {
		const [head, data] = file.src.split(',', 2);
		const bytes = Uint8Array.from(atob(data ?? ''), (c) => c.charCodeAt(0));
		const url = URL.createObjectURL(new Blob([bytes], { type: head?.slice(5).split(';')[0] }));
		window.open(url, '_blank', 'noopener');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	const open = $derived(entry.expanded ?? greenhousePrefs.values.expandTools);
	let seen: boolean | undefined;
	$effect(() => {
		const next = greenhousePrefs.values.expandTools;
		if (seen !== undefined && seen !== next) untrack(() => (entry.expanded = null));
		seen = next;
	});
	const running = $derived(isRunning(entry.status));
	const label = $derived(stepLabel(entry));
	const Icon = $derived(toolIcon(entry.name));
	const lines = $derived.by(() => {
		if (!open) return null;
		const input = (entry.input ?? {}) as Record<string, unknown>;
		const split = (value: unknown, sign: '+' | '−') =>
			typeof value === 'string' ? value.split('\n').map((text) => ({ sign, text })) : [];
		if (entry.name === 'Edit' && typeof input.new_string === 'string') {
			return [...split(input.old_string, '−'), ...split(input.new_string, '+')].slice(0, 400);
		}
		if (entry.name === 'Write' && typeof input.content === 'string') {
			return split(input.content, '+').slice(0, 400);
		}
		return null;
	});
	const command = $derived.by(() => {
		if (!open || entry.name !== 'Bash') return null;
		const input = entry.input as { command?: unknown } | null;
		return typeof input?.command === 'string' ? input.command : null;
	});
	const changed = $derived(!!entry.diff && (entry.diff.add > 0 || entry.diff.del > 0));
</script>

<StepRow
	title={label.title}
	arg={label.arg}
	hint={entry.title ?? undefined}
	{running}
	failed={entry.failed}
	{nested}
	expanded={open}
	ontoggle={() => (entry.expanded = !open)}
>
	{#snippet icon()}<Icon size={16} strokeWidth={1.75} />{/snippet}
	{#snippet trailing()}
		{#if openable && readPath}
			<button
				type="button"
				class="tool-open"
				title="Open {readPath.split('/').pop()}"
				aria-label="Open {readPath}"
				onclick={(e) => {
					e.stopPropagation();
					opener?.open(readPath);
				}}
			>
				<ExternalLink size={14} strokeWidth={1.75} />
			</button>
		{/if}
		{#if changed && entry.diff}
			<span class="tool-diff">
				{#if entry.diff.add > 0}<span class="diff-add">+{entry.diff.add}</span>{/if}
				{#if entry.diff.del > 0}<span class="diff-del">−{entry.diff.del}</span>{/if}
			</span>
		{/if}
	{/snippet}
	<div class="detail">
		{#if command !== null}
			<pre class="detail-pre detail-pre--cmd">$ {command}</pre>
		{:else if lines}
			<pre class="detail-pre">{#each lines as line, li (li)}<span
						class="detail-line"
						class:diff-add={line.sign === '+'}
						class:diff-del={line.sign === '−'}>{line.sign} {line.text}</span
					>{/each}</pre>
		{:else}
			<pre class="detail-pre">{pretty(entry.input)}</pre>
		{/if}
		{#if entry.output}
			<pre class="detail-pre detail-pre--out">{entry.output}</pre>
		{/if}
	</div>
</StepRow>
{#if images.length > 0 || documents.length > 0}
	<div class="tool-files" class:tool-files--nested={nested}>
		{#each images as image, i (i)}
			<button
				type="button"
				class="tool-thumb"
				title="View {fileName(image)}"
				onclick={() => (zoomed = image)}
			>
				<img src={image.src} alt={fileName(image)} loading="lazy" />
			</button>
		{/each}
		{#each documents as doc, i (i)}
			<button type="button" class="tool-doc" onclick={() => openDocument(doc)}>
				<FileText size={14} strokeWidth={1.75} />
				<span class="tool-doc-name">{fileName(doc)}</span>
				<ExternalLink size={12} strokeWidth={1.75} />
			</button>
		{/each}
	</div>
{/if}
{#if zoomed}
	<Modal open={!!zoomed} onclose={() => (zoomed = null)} title={fileName(zoomed)} size="xl">
		<div class="tool-zoom">
			<img src={zoomed.src} alt={fileName(zoomed)} />
		</div>
	</Modal>
{/if}

<style>
	.tool-open {
		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.tool-open:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.tool-files {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: var(--space-1) 0 var(--space-2) 1.75rem;
	}

	.tool-files--nested {
		margin-left: 2.75rem;
	}

	.tool-thumb {
		display: block;
		max-width: min(20rem, 100%);
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-sunken);
		overflow: hidden;
		cursor: zoom-in;
		transition: border-color var(--dur-fast);
	}

	.tool-thumb:hover {
		border-color: var(--border-strong);
	}

	.tool-thumb img {
		display: block;
		max-width: 100%;
		max-height: 12rem;
		object-fit: contain;
	}

	.tool-doc {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		font-size: var(--text-footnote);
		color: var(--text-default);
	}

	.tool-doc:hover {
		background: var(--bg-hover);
	}

	.tool-doc-name {
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tool-zoom {
		display: grid;
		place-items: center;
	}

	.tool-zoom img {
		max-width: 100%;
		max-height: 75vh;
		object-fit: contain;
	}

	.tool-diff {
		display: inline-flex;
		gap: var(--space-1);
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}

	.detail {
		display: flex;
		flex-direction: column;
		margin-top: var(--space-1);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-sunken);
		overflow: hidden;
	}

	.detail-pre {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		max-height: 16rem;
		overflow: auto;
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: var(--gh-code-size, 13px);
		line-height: round(up, calc(var(--gh-code-size, 13px) * 1.5), 0.25rem);
		color: var(--text-muted);
		white-space: pre;
	}

	.detail-line {
		display: block;
	}

	.detail-pre--cmd {
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.detail-pre--out {
		border-top: 1px solid var(--border-default);
		color: var(--text-faint);
	}
</style>
