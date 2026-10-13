<script lang="ts">
	import {
		Archive,
		ArchiveRestore,
		ArrowLeft,
		ArrowRight,
		ChevronDown,
		ChevronRight,
		Copy,
		ExternalLink,
		FolderGit2,
		GitFork,
		Link,
		PanelLeft,
		PanelRight,
		Pencil,
		Rocket,
		Trash2,
		Users
	} from 'lucide-svelte';
	import Menu from '@orchard/graft-ui/components/ui/Menu.svelte';
	import MenuItem from '@orchard/graft-ui/components/ui/MenuItem.svelte';
	import StatusDot from '@orchard/graft-ui/components/ui/StatusDot.svelte';
	import { previewStatus, sandboxStatus } from '../../lib/status';
	import { toasts } from '../../host/stores';
	import { getGreenhouseApp } from './app.svelte';
	import AvatarStack from './AvatarStack.svelte';
	import OpenIn from './OpenIn.svelte';
	import PrButton from './PrButton.svelte';
	import RepoIcon from './RepoIcon.svelte';
	import RunnerTile from './RunnerTile.svelte';
	import { modKey, runnerLabel } from './format';
	import { greenhousePrefs } from './prefs.svelte';
	import { VIEWER_ONLY, hostOnly, isLegacy } from './workspace.svelte';

	let {
		onrename,
		lead = null,
		compact = false
	}: { onrename: () => void; lead?: number | null; compact?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);
	const session = $derived(ws?.session ?? null);
	const archived = $derived(session?.status === 'archived');
	const lifecycleOnly = $derived(ws?.lifecycleOnly ?? false);
	const mod = modKey();
	const machineMeta = $derived(
		machine
			? sandboxStatus(machine.status, {
					applying: machine.applying,
					applyError: machine.applyError,
					desiredState: machine.desiredState
				})
			: null
	);
	const repo = $derived(
		session && ws ? (ws.repos.find((r) => r.name === session.repo) ?? null) : null
	);
	const repoSlug = $derived(repo?.github ? `${repo.github.owner}/${repo.github.name}` : null);

	const preview = $derived(
		session && (session.previewDeploymentId || session.previewUrl)
			? previewStatus(session.previewStatus)
			: null
	);

	let menuOpen = $state(false);
	let confirmDelete = $state(false);

	function setMenu(open: boolean) {
		menuOpen = open;
		if (!open) confirmDelete = false;
	}

	async function copy(text: string, title: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title, color: 'success' });
	}

	function shareLink() {
		if (!session || !machine) return;
		const url = `${location.origin}/sandboxes/${machine.id}?session=${session.id}`;
		void copy(url, 'Session link copied');
	}

	function follow(userId: string) {
		if (!ws) return;
		ws.live.follow(ws.live.following === userId ? null : userId);
	}

	function remove(deleteBranch: boolean) {
		const current = session;
		setMenu(false);
		if (current) void ws?.deleteSession(current, deleteBranch);
	}
</script>

<header class="titlebar" class:titlebar--compact={compact} data-align="topbar">
	{#if !compact}
		<div
			class="lead"
			class:lead--fixed={lead !== null}
			style:width={lead === null ? null : `${lead}px`}
		>
			<button
				type="button"
				class="gh-ibtn"
				aria-label={app.layout.leftOpen ? 'Hide sidebar' : 'Show sidebar'}
				title="{app.layout.leftOpen ? 'Hide' : 'Show'} sidebar ({mod}B)"
				onclick={() => app.layout.toggle('left')}
			>
				<PanelLeft size={16} strokeWidth={1.75} />
			</button>
			<span class="grow"></span>
			<button
				type="button"
				class="gh-ibtn"
				aria-label="Back"
				title="Back"
				disabled={!app.canBack}
				onclick={() => app.back()}
			>
				<ArrowLeft size={16} strokeWidth={1.75} />
			</button>
			<button
				type="button"
				class="gh-ibtn"
				aria-label="Forward"
				title="Forward"
				disabled={!app.canForward}
				onclick={() => app.forward()}
			>
				<ArrowRight size={16} strokeWidth={1.75} />
			</button>
		</div>
	{/if}

	<nav class="crumbs" class:crumbs--flush={lead !== null} aria-label="Location">
		{#if machine && (!compact || (lifecycleOnly && !session))}
			<button
				type="button"
				class="crumb crumb--machine"
				class:crumb--current={lifecycleOnly}
				onclick={() => app.goHome()}
				disabled={lifecycleOnly}
				aria-label="{machine.name}, {runnerLabel(machine.runner)} machine, {machineMeta?.label ??
					''}"
				title="{machine.name} · {runnerLabel(machine.runner)} machine · {machineMeta?.label ?? ''}"
			>
				<RunnerTile runner={machine.runner ?? 'kubernetes'} size={20} />
				<span class="crumb-text">{machine.name}</span>
				{#if machineMeta}<StatusDot meta={machineMeta} size={6} />{/if}
			</button>
		{/if}
		{#if session && ws}
			{#if !compact}
				<span class="sep" aria-hidden="true"><ChevronRight size={14} strokeWidth={1.75} /></span>
				<span
					class="crumb crumb--repo"
					title={repoSlug ? `${repoSlug} on GitHub` : `${session.repo} repository`}
				>
					<RepoIcon name={session.repo} github={repo?.github} icon={repo?.icon} />
					<span class="crumb-text">{session.repo}</span>
				</span>
				<span class="sep" aria-hidden="true"><ChevronRight size={14} strokeWidth={1.75} /></span>
			{/if}
			<Menu bind:open={() => menuOpen, setMenu} placement="bottom-start">
				{#snippet trigger(props, isOpen)}
					<button
						{...props}
						type="button"
						class="crumb crumb--current"
						aria-expanded={isOpen}
						aria-label="{session.title}, session actions"
					>
						<span class="crumb-text">{session.title}</span>
						<span class="caret"><ChevronDown size={14} strokeWidth={1.75} /></span>
					</button>
				{/snippet}
				<div class="gh-menu-head">
					<span class="gh-mono">{session.branch}</span>{#if session.baseBranch}
						from <span class="gh-mono">{session.baseBranch}</span>{/if}
				</div>
				<MenuItem
					onclick={onrename}
					disabled={!ws.canEdit}
					title={ws.canEdit ? undefined : VIEWER_ONLY}
				>
					<Pencil size={14} /> Rename
				</MenuItem>
				<MenuItem onclick={() => copy(session.branch, 'Branch copied')}>
					<Copy size={14} /> Copy branch name
				</MenuItem>
				<MenuItem onclick={() => copy(session.worktreePath, 'Path copied')}>
					<FolderGit2 size={14} /> Copy worktree path
				</MenuItem>
				<MenuItem onclick={shareLink}><Link size={14} /> Copy link for guests</MenuItem>
				<div class="gh-menu-sep"></div>
				<MenuItem
					onclick={() => ws.forkSession(session)}
					disabled={!ws.canEdit || isLegacy(session)}
					title={ws.canEdit ? 'New session branched from this one' : VIEWER_ONLY}
				>
					<GitFork size={14} /> Fork session
				</MenuItem>
				<MenuItem
					onclick={() => (app.sheet = 'preview')}
					disabled={!ws.isOwner || isLegacy(session)}
					title={ws.isOwner ? undefined : hostOnly('deploy previews')}
				>
					<Rocket size={14} />
					{session.previewDeploymentId ? 'Preview deploy…' : 'Deploy preview…'}
				</MenuItem>
				<div class="gh-menu-sep"></div>
				<MenuItem
					onclick={() => ws.archiveSession(session, !archived)}
					disabled={!ws.canEdit || isLegacy(session)}
					title={ws.canEdit ? undefined : VIEWER_ONLY}
				>
					{#if archived}<ArchiveRestore size={14} /> Restore{:else}<Archive size={14} />
						{greenhousePrefs.values.deleteBranchOnArchive
							? 'Archive and delete the branch'
							: 'Archive'}{/if}
				</MenuItem>
				{#if confirmDelete}
					<MenuItem danger onclick={() => remove(false)}>
						<Trash2 size={14} /> Delete, keep the branch
					</MenuItem>
					<MenuItem danger onclick={() => remove(true)}>
						<Trash2 size={14} /> Delete with the branch
					</MenuItem>
				{:else}
					<button
						type="button"
						class="ui-menu-item ui-menu-item--danger"
						role="menuitem"
						disabled={!ws.canEdit}
						title={ws.canEdit ? undefined : VIEWER_ONLY}
						onclick={() => (confirmDelete = true)}
					>
						<Trash2 size={14} /> Delete…
					</button>
				{/if}
			</Menu>
		{:else if machine && !lifecycleOnly && (app.home || !ws)}
			{#if !compact}
				<span class="sep" aria-hidden="true"><ChevronRight size={14} strokeWidth={1.75} /></span>
			{/if}
			<span class="crumb crumb--current"><span class="crumb-text">Home</span></span>
		{:else if !machine}
			<span class="crumb crumb--current"><span class="crumb-text">Greenhouse</span></span>
		{/if}
	</nav>

	<span class="grow"></span>

	<div class="trail">
		{#if ws && ws.live.others.length > 0}
			<AvatarStack
				users={ws.live.others}
				following={ws.live.following}
				size={20}
				onpick={(u) => follow(u.id)}
			/>
		{/if}
		{#if session && preview && !compact}
			{#if session.previewUrl}
				<a
					class="chip"
					href={session.previewUrl}
					target="_blank"
					rel="noopener"
					title="Preview {preview.label.toLowerCase()}, opens {session.previewUrl}"
				>
					<StatusDot meta={preview} size={6} />
					<span>Preview</span>
					<ExternalLink size={14} strokeWidth={1.75} />
				</a>
			{:else}
				<button type="button" class="chip" onclick={() => (app.sheet = 'preview')}>
					<StatusDot meta={preview} size={6} />
					<span>Preview · {preview.label}</span>
				</button>
			{/if}
		{/if}
		{#if session && ws && !compact && !lifecycleOnly}
			<OpenIn />
			<PrButton {ws} />
		{/if}
		{#if machine && ws && !lifecycleOnly}
			{#if compact}
				<button
					type="button"
					class="gh-ibtn"
					aria-label={ws.isOwner ? 'Share' : 'People'}
					title={ws.isOwner ? 'Share' : 'People'}
					onclick={() => (app.sheet = 'share')}
				>
					<Users size={16} strokeWidth={1.75} />
				</button>
			{:else}
				<button
					type="button"
					class="gh-btn gh-btn--inverse"
					data-tour="share"
					onclick={() => (app.sheet = 'share')}
				>
					{ws.isOwner ? 'Share' : 'People'}
				</button>
			{/if}
		{/if}
		{#if !app.home && !compact && !lifecycleOnly}
			<button
				type="button"
				class="gh-ibtn"
				aria-label={app.layout.rightOpen ? 'Hide panel' : 'Show panel'}
				title="{app.layout.rightOpen ? 'Hide' : 'Show'} panel ({mod}⌥B)"
				onclick={() => app.layout.toggle('right')}
			>
				<PanelRight size={16} strokeWidth={1.75} />
			</button>
		{/if}
	</div>
</header>

<style>
	.titlebar {
		display: flex;
		align-items: center;
		flex: none;
		min-width: 0;
		height: var(--gh-titlebar);
		padding-right: calc(var(--gh-gutter) + var(--gh-edge) - var(--gh-ibtn-inset));
		border-bottom: 1px solid var(--gh-line);
		background: var(--gh-frame);
	}

	.titlebar--compact {
		padding: 0 calc(var(--gh-edge) - var(--gh-ibtn-inset)) 0 var(--gh-edge);
		border-bottom: 1px solid var(--gh-line);
		background: var(--gh-editor);
	}

	.lead {
		display: flex;
		align-items: center;
		flex: none;
		min-width: 0;
		padding: 0 0.25rem 0 calc(var(--gh-side-edge) - var(--gh-ibtn-inset));
	}

	.lead--fixed {
		padding-right: calc(var(--gh-side-edge) - var(--gh-ibtn-inset));
	}

	.grow {
		flex: 1;
	}

	.lead:not(.lead--fixed) .grow {
		display: none;
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.crumbs--flush {
		margin-left: calc(var(--gh-gutter) + var(--gh-edge) - 0.5rem);
	}

	.titlebar--compact .crumbs {
		margin-left: -0.5rem;
	}

	.crumb {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		min-width: 0;
		height: var(--gh-icon);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.crumb--machine,
	.crumb--repo {
		gap: 0.5rem;
	}

	.crumb--repo {
		padding: 0 0.25rem;
		color: var(--gh-muted-strong);
	}

	.crumb--current {
		flex: 0 1 auto;
		color: var(--gh-text);
		font-weight: 600;
	}

	.crumb-text {
		min-width: 0;
		max-width: 32rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.caret {
		display: inline-grid;
		flex: none;
		color: var(--gh-muted);
	}

	button.crumb:hover:not(:disabled),
	button.crumb[aria-expanded='true'] {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	button.crumb:disabled {
		cursor: default;
	}

	button.crumb:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.sep {
		display: inline-grid;
		flex: none;
		color: var(--gh-faint);
	}

	.trail {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		margin-left: 0.5rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-icon);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.chip:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}
</style>
