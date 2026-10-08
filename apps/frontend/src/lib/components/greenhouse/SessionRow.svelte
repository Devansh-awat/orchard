<script lang="ts">
	import {
		Archive,
		ArchiveRestore,
		Copy,
		ExternalLink,
		GitPullRequest,
		Pencil,
		Trash2
	} from 'lucide-svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { toasts } from '$lib/stores';
	import AvatarStack from './AvatarStack.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import SessionGlyph from './SessionGlyph.svelte';
	import type { GhSession, RosterUser } from './types';
	import { getGreenhouseApp } from './app.svelte';
	import { VIEWER_ONLY } from './workspace.svelte';

	let {
		session,
		selected = false,
		people = []
	}: { session: GhSession; selected?: boolean; people?: readonly RosterUser[] } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const activity = $derived(ws ? ws.activity(session) : session.activity);
	const draft = $derived(ws?.hasDraft(session.id) ?? false);
	const archived = $derived(session.status === 'archived');
	const canEdit = $derived(ws?.canEdit ?? false);

	let menuOpen = $state(false);
	let mx = $state(0);
	let my = $state(0);
	let renaming = $state(false);
	let title = $state('');
	let confirmDelete = $state(false);

	function open() {
		if (renaming) return;
		app.openSession(session.id);
	}

	function context(event: MouseEvent) {
		event.preventDefault();
		mx = event.clientX;
		my = event.clientY;
		confirmDelete = false;
		menuOpen = true;
	}

	function startRename() {
		title = session.title;
		renaming = true;
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	async function commitRename() {
		if (!renaming) return;
		renaming = false;
		await ws?.renameSession(session, title);
	}

	function renameKey(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitRename();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			renaming = false;
		}
	}

	async function copyBranch() {
		await navigator.clipboard.writeText(session.branch);
		toasts.add({ title: 'Branch copied', color: 'success' });
	}
</script>

<div
	class="row"
	class:row--selected={selected}
	class:row--archived={archived}
	role="treeitem"
	aria-selected={selected}
	tabindex="-1"
	oncontextmenu={context}
>
	{#if renaming}
		<div class="main">
			<SessionGlyph {activity} {draft} merged={session.prState === 'merged'} />
			<input
				class="rename"
				bind:value={title}
				onblur={commitRename}
				onkeydown={renameKey}
				aria-label="Session title"
				{@attach focusInput}
			/>
		</div>
	{:else}
		<button
			type="button"
			class="main gh-row"
			onclick={open}
			title={`${session.title}\n${session.branch}`}
		>
			<SessionGlyph {activity} {draft} merged={session.prState === 'merged'} />
			<span class="title">{session.title}</span>
			<span class="end">
				{#if people.length > 0}
					<AvatarStack users={people} max={2} size={16} hostBadge={false} />
				{/if}
				{#if session.diffstat && (session.diffstat.additions || session.diffstat.deletions)}
					<span class="stat gh-num">
						{#if session.diffstat.additions}<span class="gh-add">+{session.diffstat.additions}</span
							>{/if}
						{#if session.diffstat.deletions}<span class="gh-del">−{session.diffstat.deletions}</span
							>{/if}
					</span>
				{:else if session.prNumber}
					<span class="stat gh-num pr">#{session.prNumber}</span>
				{/if}
			</span>
		</button>
	{/if}
</div>

<ContextMenu bind:open={menuOpen} x={mx} y={my}>
	<MenuItem onclick={startRename} disabled={!canEdit} title={canEdit ? undefined : VIEWER_ONLY}>
		<Pencil size={14} /> Rename
	</MenuItem>
	<MenuItem onclick={copyBranch}><Copy size={14} /> Copy branch name</MenuItem>
	{#if session.prUrl}
		<MenuItem href={session.prUrl} target="_blank" rel="noopener">
			<GitPullRequest size={14} /> Open PR #{session.prNumber ?? ''}
			<ExternalLink size={12} />
		</MenuItem>
	{/if}
	<div class="gh-menu-sep"></div>
	<MenuItem
		onclick={() => ws?.archiveSession(session, !archived)}
		disabled={!canEdit}
		title={canEdit ? undefined : VIEWER_ONLY}
	>
		{#if archived}<ArchiveRestore size={14} /> Restore{:else}<Archive size={14} /> Archive{/if}
	</MenuItem>
	{#if confirmDelete}
		<MenuItem danger onclick={() => ws?.deleteSession(session, false)}>
			<Trash2 size={14} /> Delete, keep the branch
		</MenuItem>
		<MenuItem danger onclick={() => ws?.deleteSession(session, true)}>
			<Trash2 size={14} /> Delete with the branch
		</MenuItem>
	{:else}
		<button
			type="button"
			class="ui-menu-item ui-menu-item--danger"
			role="menuitem"
			disabled={!canEdit}
			onclick={() => (confirmDelete = true)}
		>
			<Trash2 size={14} /> Delete…
		</button>
	{/if}
</ContextMenu>

<style>
	.row {
		position: relative;
		outline: none;
	}

	.main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: var(--gh-session-row);
		padding: 0 0.5rem 0 0.75rem;
		border-radius: var(--radius-xs);
		color: var(--gh-muted);
		text-align: left;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	button.main:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.row--selected .main {
		background: var(--gh-selected);
		color: var(--gh-text);
		font-weight: 500;
	}

	.row--archived .title {
		color: var(--gh-faint);
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.end {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex: none;
	}

	.stat {
		display: inline-flex;
		gap: 0.25rem;
		font-weight: 400;
	}

	.pr {
		color: var(--gh-faint);
	}

	.rename {
		flex: 1;
		min-width: 0;
		height: 1.5rem;
		padding: 0 0.375rem;
		border-radius: var(--radius-xs);
		border: 1px solid var(--focus-ring-color);
		background: var(--gh-editor);
		color: var(--gh-text);
		font-size: var(--gh-ui);
		outline: none;
	}
</style>
