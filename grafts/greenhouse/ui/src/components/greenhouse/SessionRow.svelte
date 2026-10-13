<script lang="ts">
	import {
		Archive,
		ArchiveRestore,
		Copy,
		Ellipsis,
		ExternalLink,
		GitPullRequest,
		Pencil,
		Trash2
	} from 'lucide-svelte';
	import MenuItem from '@orchard/graft-ui/components/ui/MenuItem.svelte';
	import { toasts } from '../../host/stores';
	import AvatarStack from './AvatarStack.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import SessionGlyph from './SessionGlyph.svelte';
	import type { GhSession, RosterUser } from './types';
	import { getGreenhouseApp } from './app.svelte';
	import { ago } from './format';
	import { VIEWER_ONLY } from './workspace.svelte';

	let {
		session,
		selected = false,
		people = [],
		now = 0
	}: {
		session: GhSession;
		selected?: boolean;
		people?: readonly RosterUser[];
		now?: number;
	} = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const activity = $derived(ws ? ws.activity(session) : session.activity);
	const draft = $derived(ws?.hasDraft(session.id) ?? false);
	const archived = $derived(session.status === 'archived');
	const canEdit = $derived(ws?.canEdit ?? false);
	const when = $derived.by(() => {
		void now;
		const text = ago(archived ? (session.archivedAt ?? session.updatedAt) : session.updatedAt);
		return text === 'just now' ? 'now' : text.replace(/ ago$/, '');
	});

	let menuOpen = $state(false);
	let placement = $state<'bottom-start' | 'bottom-end'>('bottom-start');
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
		placement = 'bottom-start';
		mx = event.clientX;
		my = event.clientY;
		confirmDelete = false;
		menuOpen = true;
	}

	let moreButton = $state<HTMLButtonElement | null>(null);

	function more() {
		if (menuOpen) {
			menuOpen = false;
			return;
		}
		if (!moreButton) return;
		const rect = moreButton.getBoundingClientRect();
		placement = 'bottom-end';
		mx = rect.right;
		my = rect.bottom + 10;
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

{#snippet meta()}
	{#if when}<span class="when">{when}</span>{/if}
{/snippet}

<div
	class="row"
	class:row--selected={selected}
	class:row--archived={archived}
	class:row--menu={menuOpen}
	role="treeitem"
	aria-selected={selected}
	tabindex="-1"
	oncontextmenu={context}
>
	{#if renaming}
		<div class="main">
			<span class="ico"
				><SessionGlyph {activity} {draft} merged={session.prState === 'merged'} /></span
			>
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
		<button type="button" class="main gh-row" title={session.branch} onclick={open}>
			<span class="ico"
				><SessionGlyph {activity} {draft} merged={session.prState === 'merged'} /></span
			>
			<span class="title">{session.title}</span>
			{@render meta()}
			{#if people.length > 0}
				<span class="people"
					><AvatarStack users={people} max={2} size={16} hostBadge={false} /></span
				>
			{/if}
		</button>
		<div class="actions">
			<button
				type="button"
				class="gh-ibtn"
				aria-label={archived ? `Restore ${session.title}` : `Archive ${session.title}`}
				title={canEdit ? (archived ? 'Restore' : 'Archive') : VIEWER_ONLY}
				disabled={!canEdit}
				onclick={() => ws?.archiveSession(session, !archived)}
			>
				{#if archived}<ArchiveRestore size={16} strokeWidth={1.75} />{:else}<Archive
						size={16}
						strokeWidth={1.75}
					/>{/if}
			</button>
			<button
				type="button"
				class="gh-ibtn"
				aria-label="More actions for {session.title}"
				title="More actions"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				bind:this={moreButton}
				onclick={more}
			>
				<Ellipsis size={16} strokeWidth={1.75} />
			</button>
		</div>
	{/if}
</div>

<ContextMenu bind:open={menuOpen} x={mx} y={my} {placement} toggle={moreButton}>
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
			title={canEdit ? undefined : VIEWER_ONLY}
			onclick={() => (confirmDelete = true)}
		>
			<Trash2 size={14} /> Delete…
		</button>
	{/if}
</ContextMenu>

<style>
	.row {
		--actions: calc(var(--gh-icon) * 2);
		position: relative;
		outline: none;
	}

	.main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: var(--gh-side-session);
		padding: 0 var(--row-pad, var(--gh-side-pad));
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		text-align: left;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.row:hover button.main,
	.row--menu .main {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.row--selected .main,
	.row--selected:hover button.main,
	.row--menu.row--selected .main {
		--gh-glyph-idle: var(--gh-side-on-icon);
		background: var(--gh-side-on);
		color: var(--gh-text);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.row--selected .title {
		font-weight: 600;
	}

	.row--archived .title {
		color: var(--gh-faint);
	}

	.when {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.people {
		display: inline-flex;
		flex: none;
		align-items: center;
	}

	.actions {
		position: absolute;
		top: 0;
		bottom: 0;
		right: calc(var(--row-pad, var(--gh-side-pad)) - var(--gh-ibtn-inset));
		display: flex;
		align-items: center;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-fast) ease;
	}

	.row:hover .actions,
	.row:focus-within .actions,
	.row--menu .actions {
		opacity: 1;
		pointer-events: auto;
	}

	.row:hover button.main,
	.row:focus-within button.main,
	.row--menu button.main {
		padding-right: calc(var(--actions) + var(--row-pad, var(--gh-side-pad)) - var(--gh-ibtn-inset));
	}

	.row:hover .when,
	.row:focus-within .when,
	.row--menu .when,
	.row:hover .people,
	.row:focus-within .people,
	.row--menu .people {
		display: none;
	}

	.rename {
		flex: 1;
		min-width: 0;
		height: 1.375rem;
		margin-left: -0.25rem;
		padding: 0 0.25rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--focus-ring-color);
		background: var(--gh-editor);
		color: var(--gh-text);
		font-size: var(--gh-ui);
		outline: none;
	}

	@media (hover: none) {
		.actions {
			opacity: 1;
			pointer-events: auto;
		}

		button.main {
			padding-right: calc(
				var(--actions) + var(--row-pad, var(--gh-side-pad)) - var(--gh-ibtn-inset)
			);
		}

		.when,
		.people {
			display: none;
		}
	}
</style>
