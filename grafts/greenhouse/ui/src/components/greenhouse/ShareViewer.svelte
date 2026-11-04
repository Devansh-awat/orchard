<script lang="ts">
	import './greenhouse.css';
	import { onDestroy, untrack } from 'svelte';
	import { Eye, FileDiff, GitBranch, MessageSquare } from 'lucide-svelte';
	import { goto } from '../../host/navigation';
	import { page } from '../../host/state.svelte';
	import EmptyState from '@orchardlabs/graft-ui/components/ui/EmptyState.svelte';
	import Skeleton from '@orchardlabs/graft-ui/components/ui/Skeleton.svelte';
	import { HumanMessage, TextPart } from '../sandbox/chat/index';
	import { EditorWorkspace, MonacoDiff } from '../sandbox/editor/index';
	import {
		ShareError,
		openShare,
		shareChanges,
		shareDiff,
		shareTranscript,
		type ShareChanges,
		type ShareTranscript,
		type ShareView
	} from './share';
	import { sidesFromUnifiedDiff, type DiffSides } from './share-diff';

	let { token, selfId = null }: { token: string | null; selfId?: string | null } = $props();

	let view = $state.raw<ShareView | null>(null);
	let phase = $state<'loading' | 'ready' | 'invalid' | 'forbidden' | 'missing' | 'error'>(
		'loading'
	);
	let failure = $state('');
	let transcript = $state.raw<ShareTranscript | null>(null);
	let transcriptState = $state<'loading' | 'ready' | 'stopped' | 'error'>('loading');
	let changes = $state.raw<ShareChanges | null>(null);
	let changesState = $state<'loading' | 'ready' | 'stopped' | 'error'>('loading');
	let diffState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');

	const sides = new Map<string, DiffSides>();
	const workspace = new EditorWorkspace({
		readFile: async (path, opts) => {
			const entry = sides.get(path);
			if (!entry) return '';
			return opts?.ref ? entry.original : entry.modified;
		},
		writeFile: async () => {}
	});
	onDestroy(() => workspace.dispose());

	const sessions = $derived(view?.sessions ?? []);
	const sid = $derived(page.url.searchParams.get('session') ?? sessions[0]?.id ?? null);
	const session = $derived(sessions.find((s) => s.id === sid) ?? null);
	const tab = $derived(page.url.searchParams.get('tab') === 'changes' ? 'changes' : 'transcript');
	const file = $derived(page.url.searchParams.get('file'));
	const docPath = $derived(file && session ? `/share/${session.id}/${file}` : null);
	const stopped = $derived(!!view && view.sandbox.status !== 'running');

	function go(next: { session?: string | null; tab?: string | null; file?: string | null }) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(next)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		const search = params.toString();
		void goto(`${page.url.pathname}${search ? `?${search}` : ''}`, {
			replaceState: true,
			keepFocus: true,
			noScroll: true
		});
	}

	let openedFor: string | null | undefined;
	$effect(() => {
		const current = token;
		if (current === openedFor) return;
		openedFor = current;
		untrack(() => {
			open(current);
		});
	});

	async function open(current: string | null) {
		if (!current) {
			phase = 'missing';
			return;
		}
		phase = 'loading';
		try {
			view = await openShare(current);
			phase = 'ready';
		} catch (e) {
			failure = e instanceof Error ? e.message : '';
			phase =
				e instanceof ShareError && (e.kind === 'invalid' || e.kind === 'forbidden')
					? e.kind
					: 'error';
		}
	}

	let loadedFor: string | null = null;
	$effect(() => {
		const id = phase === 'ready' ? sid : null;
		if (!id || !token || id === loadedFor) return;
		loadedFor = id;
		const current = token;
		untrack(() => {
			void loadTranscript(current, id);
			void loadChanges(current, id);
		});
	});

	async function loadTranscript(current: string, id: string) {
		transcriptState = 'loading';
		transcript = null;
		try {
			const res = await shareTranscript(current, id);
			if (loadedFor !== id) return;
			transcript = res;
			transcriptState = 'ready';
		} catch {
			if (loadedFor !== id) return;
			transcriptState = untrack(() => stopped) ? 'stopped' : 'error';
		}
	}

	async function loadChanges(current: string, id: string) {
		changesState = 'loading';
		changes = null;
		try {
			const res = await shareChanges(current, id);
			if (loadedFor !== id) return;
			changes = res;
			changesState = 'ready';
		} catch {
			if (loadedFor !== id) return;
			changesState = untrack(() => stopped) ? 'stopped' : 'error';
		}
	}

	let diffFor: string | null = null;
	$effect(() => {
		const path = docPath;
		const name = file;
		const id = session?.id ?? null;
		if (!path || !name || !id || !token || path === diffFor) return;
		diffFor = path;
		const current = token;
		untrack(() => {
			loadDiff(current, id, name, path);
		});
	});

	async function loadDiff(current: string, id: string, name: string, path: string) {
		diffState = 'loading';
		try {
			const res = await shareDiff(current, id, name);
			sides.set(path, sidesFromUnifiedDiff(res.diff));
			if (diffFor === path) diffState = 'ready';
		} catch {
			if (diffFor === path) diffState = 'error';
		}
	}

	function expiry(iso: string | null): string {
		if (!iso) return "Doesn't expire";
		const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
		if (days < 1) return 'Expires today';
		return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
	}

	function clock(iso: string | null): number | null {
		if (!iso) return null;
		const value = Date.parse(iso);
		return Number.isFinite(value) ? value : null;
	}

	const additions = $derived(
		(changes?.files ?? []).reduce((sum, f) => sum + (f.additions ?? 0), 0)
	);
	const deletions = $derived(
		(changes?.files ?? []).reduce((sum, f) => sum + (f.deletions ?? 0), 0)
	);
</script>

<div class="gh viewer">
	{#if phase === 'loading'}
		<div class="center">
			<Skeleton height="0.75rem" width="14rem" />
			<Skeleton height="0.75rem" width="20rem" />
		</div>
	{:else if phase !== 'ready' || !view}
		<div class="center">
			{#if phase === 'missing'}
				<EmptyState
					title="This link is incomplete"
					description="Read-only links end in a long code after #. Ask for the link again and paste all of it."
				/>
			{:else if phase === 'forbidden'}
				<EmptyState
					title="This link is for another organization"
					description="Read-only links only open for members of the organization that owns the machine. Switch accounts or ask to be invited."
				/>
			{:else if phase === 'invalid'}
				<EmptyState
					title="This link no longer works"
					description="It expired or its host revoked it. Ask them for a new one."
				/>
			{:else}
				<EmptyState
					title="Couldn't open this link"
					description={failure || 'Try again in a moment.'}
				/>
			{/if}
		</div>
	{:else}
		<header class="bar" data-align="topbar">
			<span class="ico"><Eye size={16} strokeWidth={1.75} /></span>
			<span class="name">{view.sandbox.name}</span>
			<span class="sep">Read-only</span>
			<span class="grow"></span>
			<span class="meta">
				{view.link.createdBy ? `Shared by ${view.link.createdBy.name} · ` : ''}{expiry(
					view.link.expiresAt
				)}
			</span>
		</header>

		<div class="body" class:body--single={sessions.length <= 1}>
			{#if sessions.length > 1}
				<nav class="side gh-scroll" aria-label="Shared sessions">
					<p class="side-head">Sessions</p>
					{#each sessions as s (s.id)}
						<button
							type="button"
							class="row"
							class:row--on={s.id === sid}
							aria-current={s.id === sid ? 'true' : undefined}
							onclick={() => go({ session: s.id, file: null })}
						>
							<span class="ico"><GitBranch size={16} strokeWidth={1.75} /></span>
							<span class="row-title">{s.title}</span>
						</button>
					{/each}
				</nav>
			{/if}

			<main class="main">
				{#if !session}
					<div class="center">
						<EmptyState
							title="Nothing is shared yet"
							description="The session behind this link was deleted or archived."
						/>
					</div>
				{:else}
					<div class="gh-tabs" role="tablist" aria-label="View">
						<button
							type="button"
							class="gh-tab"
							role="tab"
							aria-selected={tab === 'transcript'}
							onclick={() => go({ tab: null })}
						>
							<MessageSquare size={16} strokeWidth={1.75} /> Transcript
						</button>
						<button
							type="button"
							class="gh-tab"
							role="tab"
							aria-selected={tab === 'changes'}
							onclick={() => go({ tab: 'changes' })}
						>
							<FileDiff size={16} strokeWidth={1.75} /> Changes
							{#if changes}<span class="count gh-num">{changes.files.length}</span>{/if}
						</button>
						<span class="grow"></span>
						<span class="tab-meta gh-mono">{session.branch ?? ''}</span>
					</div>

					{#if tab === 'transcript'}
						<div class="scroll gh-scroll">
							{#if transcriptState === 'loading'}
								<div class="column">
									<Skeleton height="0.75rem" width="45%" />
									<Skeleton height="0.75rem" width="80%" />
									<Skeleton height="0.75rem" width="65%" />
								</div>
							{:else if transcriptState === 'stopped'}
								<div class="center">
									<EmptyState
										title="{view.sandbox.name} is stopped"
										description="The transcript lives on the machine. It shows up here once its host starts it."
									/>
								</div>
							{:else if transcriptState === 'error' || !transcript}
								<div class="center">
									<EmptyState
										title="Couldn't load the transcript"
										description="Try again in a moment."
									/>
								</div>
							{:else if transcript.messages.length === 0}
								<div class="center">
									<EmptyState
										title="No messages yet"
										description="Nobody has prompted the agent in this session."
									/>
								</div>
							{:else}
								<div class="column transcript" data-align="center">
									<h1 class="title">{transcript.title || session.title}</h1>
									{#each transcript.messages as m, i (m.id)}
										{@const prev = transcript.messages[i - 1]}
										<div
											class="msg"
											class:msg--turn={i > 0 && m.role === 'user' && prev?.role !== 'user'}
										>
											{#if m.role === 'user'}
												<HumanMessage
													text={m.text}
													author={m.author}
													own={!!selfId && m.author?.id === selfId}
													time={clock(m.createdAt)}
												/>
											{:else}
												<TextPart text={m.text} align />
											{/if}
											{#if m.truncated}
												<p class="truncated" data-align="content">Shortened for the shared view</p>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{:else}
						<div class="changes">
							{#if changesState === 'loading'}
								<div class="column">
									<Skeleton height="0.75rem" width="50%" />
									<Skeleton height="0.75rem" width="35%" />
								</div>
							{:else if changesState === 'stopped'}
								<div class="center">
									<EmptyState
										title="{view.sandbox.name} is stopped"
										description="The changes live in its worktree. They show up here once its host starts it."
									/>
								</div>
							{:else if changesState === 'error' || !changes}
								<div class="center">
									<EmptyState
										title="Couldn't load the changes"
										description="Try again in a moment."
									/>
								</div>
							{:else if changes.files.length === 0}
								<div class="center">
									<EmptyState
										title="No changes"
										description="This branch matches its base. The agent hasn't edited anything yet."
									/>
								</div>
							{:else}
								<nav class="files gh-scroll" aria-label="Changed files">
									<p class="side-head gh-num">
										{changes.files.length}
										{changes.files.length === 1 ? 'file' : 'files'}
										<span class="gh-add">+{additions}</span>
										<span class="gh-del">−{deletions}</span>
									</p>
									{#each changes.files as f (f.path)}
										<button
											type="button"
											class="row file"
											class:row--on={f.path === file}
											title={f.path}
											onclick={() => go({ file: f.path })}
											data-align="change-row"
										>
											<span class="row-title">{f.path.split('/').pop()}</span>
											<span class="dir">{f.path.split('/').slice(0, -1).join('/')}</span>
											<span class="gh-num stat">
												{#if f.additions}<span class="gh-add">+{f.additions}</span>{/if}
												{#if f.deletions}<span class="gh-del">−{f.deletions}</span>{/if}
											</span>
										</button>
									{/each}
								</nav>
								<div class="diff">
									{#if !docPath}
										<div class="center">
											<p class="hint">Pick a file to see its diff.</p>
										</div>
									{:else if diffState === 'loading'}
										<div class="column">
											<Skeleton height="0.75rem" width="60%" />
										</div>
									{:else if diffState === 'error'}
										<div class="center">
											<EmptyState
												title="Couldn't load this diff"
												description="Try again in a moment."
											/>
										</div>
									{:else if diffState === 'ready'}
										{#key docPath}
											<MonacoDiff {workspace} path={docPath} ref="BASE" showLayoutToggle />
										{/key}
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				{/if}
			</main>
		</div>
	{/if}
</div>

<style>
	.viewer {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		width: 100%;
		overflow: hidden;
		background: var(--gh-editor);
		color: var(--gh-text);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
	}

	.center {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		flex: 1;
		min-height: 0;
		padding: 2rem;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-bar);
		padding: 0 var(--gh-edge);
		border-bottom: 1px solid var(--gh-line);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
		color: var(--gh-muted);
	}

	.name {
		font-weight: 600;
	}

	.sep,
	.meta,
	.tab-meta {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.grow {
		flex: 1;
	}

	.body {
		display: grid;
		grid-template-columns: 17.5rem minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}

	.body--single {
		grid-template-columns: minmax(0, 1fr);
	}

	.side {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		border-right: 1px solid var(--gh-line);
		background: var(--gh-sidebar);
	}

	.side-head {
		display: flex;
		gap: 0.5rem;
		margin: 0;
		padding: 0.5rem 0.5rem 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-row);
		text-align: left;
		color: var(--gh-text);
		transition: background-color var(--dur-fast) ease;
	}

	.row:hover {
		background: var(--gh-hover);
	}

	.row--on,
	.row--on:hover {
		background: var(--gh-selected);
	}

	.row-title {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.count {
		color: var(--gh-muted);
		font-weight: 400;
	}

	.tab-meta {
		align-self: center;
		padding-right: 0.5rem;
	}

	.scroll {
		flex: 1;
		min-height: 0;
		container: chat-pane / inline-size;
	}

	.column {
		--chat-gutter: 2rem;
		--chat-inset: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		margin: 0 auto;
		padding: 2rem calc(var(--chat-gutter) + var(--chat-inset)) 4rem;
	}

	@container chat-pane (min-width: 48rem) {
		.column {
			--chat-inset: 1.5rem;
		}
	}

	.transcript {
		gap: 0.5rem;
	}

	.title {
		margin: 0 0 1rem;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
	}

	.msg {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.msg--turn {
		margin-top: 1.5rem;
	}

	.truncated {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.changes {
		display: grid;
		grid-template-columns: 20rem minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}

	.changes > .center,
	.changes > .column {
		grid-column: 1 / -1;
	}

	.files {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		border-right: 1px solid var(--gh-line);
	}

	.file {
		height: var(--gh-list-row);
	}

	.dir {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.stat {
		display: inline-flex;
		gap: 0.25rem;
		flex: none;
		font-size: var(--gh-caption);
	}

	.diff {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.diff :global(.monaco-diff-host),
	.diff > :global(*) {
		flex: 1;
		min-height: 0;
	}

	.hint {
		margin: 0;
		color: var(--gh-faint);
	}
</style>
