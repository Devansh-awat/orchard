<script lang="ts">
	import {
		ArrowDown,
		ArrowUp,
		ChevronDown,
		GitCommitHorizontal,
		LoaderCircle,
		RefreshCw
	} from 'lucide-svelte';
	import Menu from '@orchard/graft-ui/components/ui/Menu.svelte';
	import MenuItem from '@orchard/graft-ui/components/ui/MenuItem.svelte';
	import Skeleton from '@orchard/graft-ui/components/ui/Skeleton.svelte';
	import { goto } from '../../host/navigation';
	import { toasts } from '../../host/stores';
	import * as api from './api';
	import {
		LINK_GITHUB,
		VIEWER_ONLY,
		isPreparing,
		scopeOf,
		type MachineWorkspace
	} from './workspace.svelte';
	import { modKey } from './format';
	import type { GhChangedFile, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession } = $props();

	const data = $derived(ws.changes.get(session.id) ?? null);
	const loadError = $derived(ws.changesError.get(session.id) ?? null);
	const files = $derived(data?.files ?? []);
	const staged = $derived(files.filter((f) => f.staged));
	const unstaged = $derived(files.filter((f) => !f.staged));
	const ahead = $derived(data?.ahead ?? session.aheadBehind?.ahead ?? 0);
	const behind = $derived(data?.behind ?? session.aheadBehind?.behind ?? 0);
	const commitPrimary = $derived(!ws.prIsPrimary);
	const activeDiff = $derived.by(() => {
		const tab = ws.activeTab;
		return tab?.kind === 'diff' ? ws.resolve(tab.path).rel : null;
	});
	const pushBlocked = $derived(
		!ws.canEdit ? VIEWER_ONLY : ws.githubLinked === false ? LINK_GITHUB : undefined
	);

	const mod = modKey();
	const STATUS: Record<string, string> = {
		M: 'Modified',
		A: 'Added',
		U: 'Untracked',
		D: 'Deleted',
		R: 'Renamed'
	};

	let message = $state('');
	let busy = $state<string | null>(null);
	let refreshing = $state(false);
	const BUSY_VERB: Record<string, string> = {
		Fetch: 'Fetching…',
		Pull: 'Pulling…',
		Push: 'Pushing…'
	};

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await ws.refreshChanges(session.id);
		} finally {
			refreshing = false;
		}
	}
	let menuOpen = $state(false);

	function split(path: string) {
		const i = path.lastIndexOf('/');
		return i === -1 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
	}

	function letter(file: GhChangedFile) {
		const s = file.status.trim().charAt(0).toUpperCase();
		return s === '?' ? 'U' : s || 'M';
	}

	async function run(label: string, fn: () => Promise<api.GitOutput | void>) {
		if (busy) return;
		busy = label;
		try {
			const out = await fn();
			if (out && !out.ok) throw new Error(out.output || `${label} failed`);
			await ws.refreshChanges(session.id);
			void ws.refreshSessions();
		} catch (e) {
			if (api.isGithubUnlinked(e)) {
				ws.githubUnlinked = true;
				toasts.add({
					title: LINK_GITHUB,
					description: 'Pushes and pulls run with your own GitHub account.',
					color: 'info',
					action: { label: 'Link GitHub', onClick: () => goto(api.LINK_GITHUB_HREF) }
				});
				return;
			}
			toasts.add({
				title: `${label} failed`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	function commit(amend = false) {
		const text = message.trim();
		if (!text && !amend) return;
		return run(amend ? 'Amend' : 'Commit', async () => {
			const out = await api.gitCommit(ws.sandboxId, scopeOf(session), { message: text, amend });
			if (out.ok) message = '';
			return out;
		});
	}

	function commitKey(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void commit();
		}
	}
</script>

{#snippet fileRow(file: GhChangedFile)}
	{@const parts = split(file.path)}
	{@const l = letter(file)}
	<button
		type="button"
		class="file"
		class:file--selected={activeDiff === file.path}
		aria-current={activeDiff === file.path ? 'true' : undefined}
		data-align="change-row"
		title={file.path}
		onclick={() => ws.openDiff(file.path)}
	>
		<span class="name" data-align="right-edge">{parts.name}</span>
		<span class="dir">{parts.dir}</span>
		<span class="stat gh-num" data-align="change-stat">
			{#if file.additions}<span class="gh-add">+{file.additions}</span>{/if}
			{#if file.deletions}<span class="gh-del">−{file.deletions}</span>{/if}
		</span>
		<span class="letter letter--{l}" title={STATUS[l] ?? 'Modified'}>{l}</span>
	</button>
{/snippet}

<div class="changes">
	<div class="commit">
		<textarea
			class="msg"
			data-align="right-edge"
			rows="2"
			bind:value={message}
			placeholder={ws.canEdit ? 'Commit message' : VIEWER_ONLY}
			disabled={!ws.canEdit || !ws.running}
			onkeydown={commitKey}></textarea>
		<div class="actions">
			<div
				class="gh-split"
				class:gh-split--primary={commitPrimary}
				role="group"
				aria-label="Commit"
			>
				<button
					type="button"
					disabled={!ws.canEdit ||
						ws.gitIdentity?.canCommit === false ||
						!message.trim() ||
						files.length === 0 ||
						!!busy}
					title="Commit ({mod}Enter)"
					onclick={() => commit()}
				>
					<GitCommitHorizontal size={14} strokeWidth={1.75} />
					{busy === 'Commit' ? 'Committing…' : 'Commit'}
				</button>
				<Menu bind:open={menuOpen} placement="bottom-end">
					{#snippet trigger(props, isOpen)}
						<button
							{...props}
							type="button"
							aria-label="More commit actions"
							title="More commit actions"
							aria-expanded={isOpen}
							disabled={!ws.canEdit}
						>
							<ChevronDown size={14} strokeWidth={1.75} />
						</button>
					{/snippet}
					<MenuItem onclick={() => commit(true)}>Amend last commit</MenuItem>
					<MenuItem
						onclick={() => run('Fetch', () => api.gitFetch(ws.sandboxId, scopeOf(session)))}
						disabled={!ws.canPush}
						title={pushBlocked}
					>
						Fetch
					</MenuItem>
				</Menu>
			</div>
			<span class="who">
				{#if busy && BUSY_VERB[busy]}
					{BUSY_VERB[busy]}
				{:else if ws.canEdit && ws.githubLinked === false}
					<a class="link" href={api.LINK_GITHUB_HREF}>{LINK_GITHUB}</a>
				{:else if ws.canPush && ws.pushAs}
					You’ll push as @{ws.pushAs}
				{/if}
			</span>
			<button
				type="button"
				class="gh-btn gh-btn--ghost sync"
				disabled={!ws.canPush || behind === 0 || !!busy}
				title={pushBlocked ?? `Pull ${behind} with rebase`}
				onclick={() => run('Pull', () => api.gitPull(ws.sandboxId, scopeOf(session)))}
			>
				{#if busy === 'Pull'}
					<span class="animate-spin inline-grid" data-motion="progress"
						><LoaderCircle size={14} strokeWidth={1.75} /></span
					>
				{:else}
					<ArrowDown size={14} strokeWidth={1.75} />
				{/if}<span class="gh-num">{behind}</span>
			</button>
			<button
				type="button"
				class="gh-btn gh-btn--ghost sync"
				disabled={!ws.canPush || ahead === 0 || !!busy}
				title={pushBlocked ?? `Push ${ahead}`}
				onclick={() => run('Push', () => api.gitPush(ws.sandboxId, scopeOf(session)))}
			>
				{#if busy === 'Push'}
					<span class="animate-spin inline-grid" data-motion="progress"
						><LoaderCircle size={14} strokeWidth={1.75} /></span
					>
				{:else}
					<ArrowUp size={14} strokeWidth={1.75} />
				{/if}<span class="gh-num">{ahead}</span>
			</button>
			<button
				type="button"
				class="gh-ibtn"
				aria-label="Refresh changes"
				title="Refresh changes"
				aria-busy={refreshing}
				onclick={refresh}
			>
				<span class="inline-grid" class:animate-spin={refreshing} data-motion="progress"
					><RefreshCw size={16} strokeWidth={1.75} /></span
				>
			</button>
		</div>
	</div>

	<div class="list gh-scroll">
		{#if !data && !ws.running}
			<p class="note">Start {ws.machine?.name ?? 'the machine'} to see changes.</p>
		{:else if !data && isPreparing(session)}
			<p class="note">Changes show up once the worktree is ready.</p>
		{:else if !data && loadError}
			<p class="note">
				{loadError}
				<button type="button" class="retry" onclick={() => ws.refreshChanges(session.id)}
					>Try again</button
				>
			</p>
		{:else if !data}
			<div class="skeletons">
				<Skeleton height="0.625rem" width="60%" />
				<Skeleton height="0.625rem" width="45%" />
				<Skeleton height="0.625rem" width="52%" />
			</div>
		{:else if files.length === 0}
			<p class="note">No changes yet. Edits from the agent and from you show up here.</p>
		{:else}
			{#if staged.length > 0}
				<p class="group">Staged <span class="gh-num">{staged.length}</span></p>
				{#each staged as file (file.path)}{@render fileRow(file)}{/each}
			{/if}
			{#if unstaged.length > 0}
				{#if staged.length > 0}
					<p class="group">Changes <span class="gh-num">{unstaged.length}</span></p>
				{/if}
				{#each unstaged as file (file.path)}{@render fileRow(file)}{/each}
			{/if}
		{/if}
	</div>
</div>

<style>
	.changes {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.commit {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: none;
		padding: var(--gh-edge);
		border-bottom: 1px solid var(--gh-line-soft);
	}

	.msg {
		width: 100%;
		min-height: 3.5rem;
		padding: 0.5rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
		color: var(--gh-text);
		font: inherit;
		line-height: var(--gh-lh-ui);
		resize: vertical;
		outline: none;
	}

	.msg:focus {
		border-color: var(--focus-ring-color);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.msg::placeholder {
		color: var(--gh-faint);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.who {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.link {
		color: var(--gh-text);
		text-decoration: underline;
		text-decoration-color: var(--gh-line);
		text-underline-offset: 2px;
	}

	.link:hover {
		text-decoration-color: currentColor;
	}

	.sync {
		gap: 0.25rem;
		padding: 0 0.5rem;
	}

	.list {
		flex: 1;
		min-height: 0;
		padding: 0.25rem calc(var(--gh-edge) - 0.5rem) 1rem;
	}

	.group {
		margin: 0.5rem 0 0;
		padding: 0.25rem 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.group:first-child {
		margin-top: 0;
	}

	.file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: var(--gh-list-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-row);
		text-align: left;
		white-space: nowrap;
		transition: background-color var(--dur-fast) ease;
	}

	.file:hover {
		background: var(--gh-hover);
	}

	.file--selected,
	.file--selected:hover {
		background: var(--gh-selected);
	}

	.file--selected .name {
		font-weight: 600;
	}

	.name {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--gh-text);
	}

	.dir {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		direction: rtl;
		text-align: left;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.stat {
		display: inline-flex;
		gap: 0.5rem;
		flex: none;
	}

	.letter {
		flex: none;
		width: 1rem;
		text-align: center;
		font-family: var(--gh-mono);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		color: var(--gh-mod);
	}

	.letter--A,
	.letter--U {
		color: var(--gh-new);
	}

	.letter--D {
		color: var(--gh-del);
	}

	.note {
		margin: 0;
		padding: 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.retry {
		color: var(--gh-text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
	}
</style>
