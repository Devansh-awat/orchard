<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { untrack } from 'svelte';
	import {
		ChevronRight,
		Copy,
		FilePlus,
		FileText,
		Folder,
		FolderOpen,
		FolderPlus,
		Pencil,
		SquareTerminal,
		Trash2
	} from 'lucide-svelte';
	import MenuItem from '@orchard/graft-ui/components/ui/MenuItem.svelte';
	import Skeleton from '@orchard/graft-ui/components/ui/Skeleton.svelte';
	import { toasts } from '../../host/stores';
	import { springRotate } from '@orchard/graft-ui/utils/motion.svelte';
	import * as api from './api';
	import ContextMenu from './ContextMenu.svelte';
	import { VIEWER_ONLY, scopeOf, type MachineWorkspace } from './workspace.svelte';
	import type { GhFileNode, GhSession } from './types';

	let {
		ws,
		session,
		filter = '',
		onterminal
	}: {
		ws: MachineWorkspace;
		session: GhSession;
		filter?: string;
		onterminal?: (dir: string) => void;
	} = $props();

	const dirs = new SvelteMap<string, GhFileNode[]>();
	const open = new SvelteSet<string>();
	const loading = new SvelteSet<string>();
	let matches = $state<string[] | null>(null);
	let creating = $state<{ parent: string; kind: 'file' | 'directory' } | null>(null);
	let renaming = $state<string | null>(null);
	let draftName = $state('');

	let menuOpen = $state(false);
	let mx = $state(0);
	let my = $state(0);
	let target = $state<GhFileNode | null>(null);

	const activePath = $derived.by(() => {
		const tab = ws.activeTab;
		if (!tab || (tab.kind !== 'file' && tab.kind !== 'diff')) return null;
		return ws.resolve(tab.path).rel;
	});

	const decorations = $derived.by(() => {
		const map = new Map<string, string>();
		const changes = ws.changes.get(session.id);
		for (const file of changes?.files ?? []) {
			const letter = file.status.trim().charAt(0).toUpperCase() || 'M';
			map.set(file.path, letter === '?' ? 'U' : letter);
			const parts = file.path.split('/');
			for (let i = 1; i < parts.length; i++) {
				const dir = parts.slice(0, i).join('/');
				if (!map.has(dir)) map.set(dir, '•');
			}
		}
		return map;
	});

	async function load(path: string) {
		if (loading.has(path)) return;
		loading.add(path);
		const list = await api.listDir(ws.sandboxId, session.worktreePath, path);
		list.sort((a, b) =>
			a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
		);
		dirs.set(path, list);
		loading.delete(path);
	}

	let loadedFor: string | null = null;
	$effect(() => {
		const key = `${session.id}:${ws.running}`;
		if (key === loadedFor) return;
		loadedFor = key;
		untrack(() => {
			dirs.clear();
			open.clear();
			if (ws.running) void load('');
		});
	});

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const q = filter.trim();
		if (searchTimer) clearTimeout(searchTimer);
		if (!q) {
			matches = null;
			return;
		}
		searchTimer = setTimeout(async () => {
			matches = await api.findFiles(ws.sandboxId, session.worktreePath, q, 60);
		}, 160);
	});

	function toggle(node: GhFileNode) {
		if (node.type === 'file') {
			ws.openFile(node.path);
			return;
		}
		if (open.has(node.path)) {
			open.delete(node.path);
			return;
		}
		open.add(node.path);
		if (!dirs.has(node.path)) void load(node.path);
	}

	function context(event: MouseEvent, node: GhFileNode | null) {
		event.preventDefault();
		target = node;
		mx = event.clientX;
		my = event.clientY;
		menuOpen = true;
	}

	function parentOf(path: string): string {
		const i = path.lastIndexOf('/');
		return i === -1 ? '' : path.slice(0, i);
	}

	function startCreate(kind: 'file' | 'directory') {
		const node = target;
		const parent = node ? (node.type === 'directory' ? node.path : parentOf(node.path)) : '';
		if (parent) open.add(parent);
		creating = { parent, kind };
		draftName = '';
	}

	function startRename() {
		if (!target) return;
		renaming = target.path;
		draftName = target.name;
	}

	async function refresh(path: string) {
		await load(path);
		void ws.refreshChanges(session.id);
	}

	async function commitCreate() {
		const pending = creating;
		creating = null;
		const name = draftName.trim();
		if (!pending || !name) return;
		const path = pending.parent ? `${pending.parent}/${name}` : name;
		try {
			if (pending.kind === 'directory') {
				await api.fsOp(ws.sandboxId, 'mkdir', scopeOf(session), { path });
			} else {
				await api.writeFile(ws.sandboxId, scopeOf(session), path, '');
				ws.openFile(path);
			}
			await refresh(pending.parent);
		} catch (e) {
			toasts.add({
				title: `Could not create ${name}`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async function commitRename() {
		const from = renaming;
		renaming = null;
		const name = draftName.trim();
		if (!from || !name || name === from.split('/').pop()) return;
		const parent = parentOf(from);
		const to = parent ? `${parent}/${name}` : name;
		try {
			await api.fsOp(ws.sandboxId, 'rename', scopeOf(session), { path: from, to });
			await refresh(parent);
		} catch (e) {
			toasts.add({
				title: 'Rename failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async function remove() {
		const node = target;
		if (!node) return;
		if (!confirm(`Delete ${node.path}? This cannot be undone.`)) return;
		try {
			await api.fsOp(ws.sandboxId, 'delete', scopeOf(session), { path: node.path });
			await refresh(parentOf(node.path));
		} catch (e) {
			toasts.add({
				title: 'Delete failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	async function copyPath() {
		if (!target) return;
		await navigator.clipboard.writeText(target.path);
		toasts.add({ title: 'Path copied', color: 'success' });
	}

	function nameKey(event: KeyboardEvent, commit: () => void) {
		if (event.key === 'Enter') {
			event.preventDefault();
			commit();
		} else if (event.key === 'Escape') {
			creating = null;
			renaming = null;
		}
	}

	function focus(node: HTMLInputElement) {
		node.focus();
		const dot = node.value.lastIndexOf('.');
		node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
	}

	export function create(kind: 'file' | 'directory') {
		target = null;
		startCreate(kind);
	}

	export function collapseAll() {
		open.clear();
	}
</script>

{#snippet draftRow(depth: number, kind: 'file' | 'directory')}
	<div class="row" style="--depth: {depth}">
		<span class="twisty"></span>
		<span class="ico"
			>{#if kind === 'directory'}<Folder size={16} strokeWidth={1.75} />{:else}<FileText
					size={16}
					strokeWidth={1.75}
				/>{/if}</span
		>
		<input
			class="name-field gh-mono"
			bind:value={draftName}
			placeholder={kind === 'directory' ? 'folder name' : 'file name'}
			onkeydown={(e) => nameKey(e, commitCreate)}
			onblur={commitCreate}
			{@attach focus}
		/>
	</div>
{/snippet}

{#snippet level(path: string, depth: number)}
	{#if creating && creating.parent === path}
		{@render draftRow(depth, creating.kind)}
	{/if}
	{#each dirs.get(path) ?? [] as node (node.path)}
		{@const isOpen = open.has(node.path)}
		{@const deco = decorations.get(node.path)}
		{#if renaming === node.path}
			<div class="row" style="--depth: {depth}">
				<span class="twisty"></span>
				<span class="ico"><FileText size={16} strokeWidth={1.75} /></span>
				<input
					class="name-field gh-mono"
					bind:value={draftName}
					onkeydown={(e) => nameKey(e, commitRename)}
					onblur={commitRename}
					{@attach focus}
				/>
			</div>
		{:else}
			<button
				type="button"
				class="row"
				class:row--ignored={node.ignored}
				class:row--changed={!!deco}
				class:row--selected={activePath === node.path}
				style="--depth: {depth}"
				role="treeitem"
				data-align="tree-row"
				aria-expanded={node.type === 'directory' ? isOpen : undefined}
				aria-selected={activePath === node.path}
				title={node.path}
				onclick={() => toggle(node)}
				ondblclick={() => node.type === 'file' && ws.openFile(node.path)}
				oncontextmenu={(e) => context(e, node)}
			>
				<span class="twisty" data-align={depth === 0 ? 'right-edge' : undefined}>
					{#if node.type === 'directory'}<span
							class="twisty-glyph"
							{@attach springRotate(() => isOpen, { rest: 0, on: 90 })}
							><ChevronRight size={14} strokeWidth={1.75} /></span
						>{/if}
				</span>
				<span class="ico">
					{#if node.type === 'directory'}
						{#if isOpen}<FolderOpen size={16} strokeWidth={1.75} />{:else}<Folder
								size={16}
								strokeWidth={1.75}
							/>{/if}
					{:else}
						<FileText size={16} strokeWidth={1.75} />
					{/if}
				</span>
				<span class="name">{node.name}</span>
				{#if deco}<span class="deco deco--{deco === '•' ? 'dot' : deco}">{deco}</span>{/if}
			</button>
			{#if node.type === 'directory' && isOpen}
				{#if loading.has(node.path) && !dirs.has(node.path)}
					<div class="row row--skeleton" style="--depth: {depth + 1}">
						<Skeleton height="0.625rem" width="60%" />
					</div>
				{:else}
					{@render level(node.path, depth + 1)}
				{/if}
			{/if}
		{/if}
	{/each}
{/snippet}

<div
	class="tree gh-scroll"
	role="tree"
	aria-label="Files in {session.repo}"
	tabindex="-1"
	oncontextmenu={(e) => e.target === e.currentTarget && context(e, null)}
>
	{#if !ws.running}
		<p class="note">Start the machine to browse files.</p>
	{:else if matches}
		{#each matches as path (path)}
			<button
				type="button"
				class="row"
				style="--depth: 0"
				data-align="tree-row"
				onclick={() => ws.openFile(path)}
			>
				<span class="ico" data-align="right-edge"><FileText size={16} strokeWidth={1.75} /></span>
				<span class="name gh-mono">{path}</span>
			</button>
		{:else}
			<p class="note">No files match “{filter}”.</p>
		{/each}
	{:else if !dirs.has('')}
		<div class="skeletons">
			<Skeleton height="0.625rem" width="40%" />
			<Skeleton height="0.625rem" width="55%" />
			<Skeleton height="0.625rem" width="35%" />
			<Skeleton height="0.625rem" width="48%" />
		</div>
	{:else}
		{@render level('', 0)}
	{/if}
</div>

<ContextMenu bind:open={menuOpen} x={mx} y={my}>
	{#if target?.type === 'file'}
		<MenuItem onclick={() => target && ws.openFile(target.path)}>
			<FileText size={14} /> Open in editor tab
		</MenuItem>
		{#if decorations.has(target.path)}
			<MenuItem onclick={() => target && ws.openDiff(target.path)}>
				<FileText size={14} /> Open changes
			</MenuItem>
		{/if}
		<div class="gh-menu-sep"></div>
	{/if}
	<MenuItem
		onclick={() => startCreate('file')}
		disabled={!ws.canEdit}
		title={ws.canEdit ? undefined : VIEWER_ONLY}
	>
		<FilePlus size={14} /> New file
	</MenuItem>
	<MenuItem
		onclick={() => startCreate('directory')}
		disabled={!ws.canEdit}
		title={ws.canEdit ? undefined : VIEWER_ONLY}
	>
		<FolderPlus size={14} /> New folder
	</MenuItem>
	{#if target}
		<MenuItem onclick={startRename} disabled={!ws.canEdit}>
			<Pencil size={14} /> Rename
		</MenuItem>
		<MenuItem onclick={copyPath}><Copy size={14} /> Copy path</MenuItem>
		{#if onterminal}
			<MenuItem
				onclick={() =>
					target && onterminal(target.type === 'directory' ? target.path : parentOf(target.path))}
			>
				<SquareTerminal size={14} /> Reveal in terminal
			</MenuItem>
		{/if}
		<div class="gh-menu-sep"></div>
		<MenuItem danger onclick={remove} disabled={!ws.canEdit}>
			<Trash2 size={14} /> Delete
		</MenuItem>
	{/if}
</ContextMenu>

<style>
	.tree {
		flex: 1;
		min-height: 0;
		padding: 0.25rem calc(var(--gh-edge) - 0.5rem) 1rem;
		outline: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		height: var(--gh-list-row);
		padding: 0 0.5rem 0 calc(0.5rem + var(--depth) * 1rem);
		border-radius: var(--gh-r-row);
		color: var(--gh-muted);
		text-align: left;
		white-space: nowrap;
		transition: background-color var(--dur-fast) ease;
	}

	button.row:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.row--changed {
		color: var(--gh-text);
	}

	.row--selected,
	button.row--selected:hover {
		background: var(--gh-selected);
		color: var(--gh-text);
		font-weight: 600;
	}

	.row--ignored {
		opacity: 0.55;
	}

	.twisty,
	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.twisty {
		color: var(--gh-faint);
	}

	.twisty-glyph {
		display: inline-grid;
	}

	.name {
		flex: 1;
		min-width: 0;
		margin-left: 0.25rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.deco {
		flex: none;
		width: 1rem;
		text-align: center;
		font-family: var(--gh-mono);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		color: var(--gh-mod);
	}

	.deco--A,
	.deco--U {
		color: var(--gh-new);
	}

	.deco--D {
		color: var(--gh-del);
	}

	.deco--dot {
		color: var(--gh-mod);
		opacity: 0.8;
	}

	.name-field {
		flex: 1;
		min-width: 0;
		height: 1.5rem;
		margin-left: 0.25rem;
		padding: 0 0.25rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--focus-ring-color);
		background: var(--gh-field);
		color: var(--gh-text);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		outline: none;
	}

	.note {
		margin: 0;
		padding: 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
	}
</style>
