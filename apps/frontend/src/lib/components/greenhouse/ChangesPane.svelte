<script lang="ts">
	import { ArrowDown, ArrowUp, ChevronDown, GitCommitHorizontal, RefreshCw } from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { OWNER_ONLY, VIEWER_ONLY, scopeOf, type MachineWorkspace } from './workspace.svelte';
	import type { GhChangedFile, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession } = $props();

	const data = $derived(ws.changes.get(session.id) ?? null);
	const files = $derived(data?.files ?? []);
	const staged = $derived(files.filter((f) => f.staged));
	const unstaged = $derived(files.filter((f) => !f.staged));
	const ahead = $derived(data?.ahead ?? session.aheadBehind?.ahead ?? 0);
	const behind = $derived(data?.behind ?? session.aheadBehind?.behind ?? 0);

	let message = $state('');
	let busy = $state<string | null>(null);
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
	<button type="button" class="file" title={file.path} onclick={() => ws.openDiff(file.path)}>
		<span class="name">{parts.name}</span>
		<span class="dir">{parts.dir}</span>
		<span class="stat gh-num">
			{#if file.additions}<span class="gh-add">+{file.additions}</span>{/if}
			{#if file.deletions}<span class="gh-del">−{file.deletions}</span>{/if}
		</span>
		<span class="letter letter--{l}">{l}</span>
	</button>
{/snippet}

<div class="changes">
	<div class="commit">
		<textarea
			class="msg"
			rows="2"
			bind:value={message}
			placeholder={ws.canEdit ? 'Commit message' : VIEWER_ONLY}
			disabled={!ws.canEdit || !ws.running}
			onkeydown={commitKey}></textarea>
		<div class="actions">
			<div class="gh-split gh-split--primary" role="group" aria-label="Commit">
				<button
					type="button"
					disabled={!ws.canEdit || !message.trim() || files.length === 0 || !!busy}
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
							aria-expanded={isOpen}
							disabled={!ws.canEdit}
						>
							<ChevronDown size={14} strokeWidth={1.75} />
						</button>
					{/snippet}
					<MenuItem onclick={() => commit(true)}>Amend last commit</MenuItem>
					<MenuItem
						onclick={() => run('Fetch', () => api.gitFetch(ws.sandboxId, scopeOf(session)))}
					>
						Fetch
					</MenuItem>
				</Menu>
			</div>
			<span class="grow"></span>
			<button
				type="button"
				class="gh-btn gh-btn--ghost sync"
				disabled={!ws.isOwner || behind === 0 || !!busy}
				title={ws.isOwner ? 'Pull with rebase' : OWNER_ONLY}
				onclick={() => run('Pull', () => api.gitPull(ws.sandboxId, scopeOf(session)))}
			>
				<ArrowDown size={13} strokeWidth={1.75} /><span class="gh-num">{behind}</span>
			</button>
			<button
				type="button"
				class="gh-btn gh-btn--ghost sync"
				disabled={!ws.isOwner || ahead === 0 || !!busy}
				title={ws.isOwner ? 'Push' : OWNER_ONLY}
				onclick={() => run('Push', () => api.gitPush(ws.sandboxId, scopeOf(session)))}
			>
				<ArrowUp size={13} strokeWidth={1.75} /><span class="gh-num">{ahead}</span>
			</button>
			<button
				type="button"
				class="gh-ibtn"
				aria-label="Refresh changes"
				title="Refresh"
				onclick={() => ws.refreshChanges(session.id)}
			>
				<RefreshCw size={14} strokeWidth={1.75} />
			</button>
		</div>
	</div>

	<div class="list gh-scroll">
		{#if !data}
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
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--gh-line-soft);
	}

	.msg {
		width: 100%;
		min-height: 3.25rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
		color: var(--gh-text);
		font: inherit;
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
		gap: 0.25rem;
	}

	.grow {
		flex: 1;
	}

	.sync {
		gap: 0.25rem;
		padding: 0 0.375rem;
	}

	.list {
		flex: 1;
		min-height: 0;
		padding: 0.25rem 0.375rem 1rem;
	}

	.group {
		margin: 0.5rem 0 0.125rem;
		padding: 0 0.5rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: 1.75rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-xs);
		text-align: left;
		white-space: nowrap;
		transition: background-color var(--dur-fast) ease;
	}

	.file:hover {
		background: var(--gh-hover);
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
		color: var(--gh-faint);
	}

	.stat {
		display: inline-flex;
		gap: 0.375rem;
		flex: none;
	}

	.letter {
		flex: none;
		width: 1rem;
		text-align: center;
		font-family: var(--gh-mono);
		font-size: var(--gh-caption);
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
		padding: 0.75rem 0.5rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.75rem 0.5rem;
	}
</style>
