<script lang="ts">
	import {
		ArrowLeft,
		ArrowRight,
		ChevronRight,
		CircleHelp,
		House,
		PanelLeft,
		Plus,
		Search,
		Settings
	} from 'lucide-svelte';
	import { springCollapse, springRotate } from '$lib/utils/motion.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import MachineMenu from './MachineMenu.svelte';
	import SessionRow from './SessionRow.svelte';
	import { ago, modKey, repoHue, repoInitial, runnerLabel } from './format';
	import { VIEWER_ONLY, hostOnly } from './workspace.svelte';

	let {
		onnewsession,
		compact = false
	}: { onnewsession: (repo?: string | null) => void; compact?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);
	const mod = modKey();

	let collapsed = $state<Record<string, boolean>>({});
	let archivedOpen = $state(false);

	function search() {
		window.dispatchEvent(new Event('open-quick-search'));
	}

	const idleTitle = $derived(
		machine?.lastActiveAt
			? `Last active ${ago(machine.lastActiveAt)}. Idle machines stop on their own.`
			: 'Idle machines stop on their own.'
	);
</script>

<nav class="side" aria-label="Greenhouse">
	<div class="bar" data-align="topbar">
		{#if !compact}
			<button
				type="button"
				class="gh-ibtn"
				data-align="sidebar-icon"
				aria-label="Hide sidebar"
				title="Hide sidebar ({mod}B)"
				onclick={() => app.layout.toggle('left')}
			>
				<PanelLeft size={16} strokeWidth={1.75} />
			</button>
		{/if}
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

	<div class="top">
		<MachineMenu />
		<div class="rows">
			<button
				type="button"
				class="nav gh-row"
				class:nav--on={app.home}
				aria-current={app.home ? 'page' : undefined}
				onclick={() => app.goHome()}
			>
				<span class="ico" data-align="sidebar-icon"><House size={16} strokeWidth={1.75} /></span>
				<span class="label" data-align="sidebar-label">Home</span>
			</button>
			<button
				type="button"
				class="nav gh-row"
				onclick={() => onnewsession(null)}
				disabled={ws ? !ws.canEdit : false}
				title={ws && !ws.canEdit ? VIEWER_ONLY : `New session (${mod}N)`}
			>
				<span class="ico" data-align="sidebar-icon"><Plus size={16} strokeWidth={1.75} /></span>
				<span class="label" data-align="sidebar-label">New session</span>
				<span class="gh-kbd" data-align="sidebar-end">{mod}N</span>
			</button>
			<button type="button" class="nav gh-row" title="Search ({mod}K)" onclick={search}>
				<span class="ico" data-align="sidebar-icon"><Search size={16} strokeWidth={1.75} /></span>
				<span class="label" data-align="sidebar-label">Search</span>
				<span class="gh-kbd" data-align="sidebar-end">{mod}K</span>
			</button>
		</div>
	</div>

	<div class="list gh-scroll" role="tree" aria-label="Repositories">
		<div class="section">
			<span class="section-title">Repositories</span>
			<button
				type="button"
				class="gh-ibtn add"
				aria-label="Add repository"
				title={ws && !ws.isOwner
					? hostOnly('clone repositories')
					: 'Clone a repository onto this machine'}
				disabled={!ws?.isOwner || !ws?.running}
				onclick={() => (app.sheet = 'add-repo')}
			>
				<Plus size={16} strokeWidth={1.75} />
			</button>
		</div>

		{#if ws?.lifecycleOnly}
			<p class="hint">Only the host and people they invite can see what is on this machine.</p>
		{:else if ws}
			{#each ws.groups as group (group.name)}
				{@const closed = collapsed[group.name] ?? false}
				<div class="group" role="group" aria-label={group.name}>
					<div class="repo">
						<button
							type="button"
							class="repo-main gh-row"
							aria-expanded={!closed}
							onclick={() => (collapsed[group.name] = !closed)}
						>
							<span class="ico" data-align="sidebar-icon">
								<span class="avatar" style="--hue: var({repoHue(group.name)})">
									{repoInitial(group.name)}
								</span>
							</span>
							<span class="label repo-name" data-align="sidebar-label">{group.name}</span>
							<span class="chev" {@attach springRotate(() => !closed, { rest: 0, on: 90 })}>
								<ChevronRight size={16} strokeWidth={1.75} />
							</span>
						</button>
						<button
							type="button"
							class="gh-ibtn repo-add"
							aria-label="New session in {group.name}"
							title={ws.canEdit ? `New session in ${group.name}` : VIEWER_ONLY}
							disabled={!ws.canEdit}
							onclick={() => onnewsession(group.name)}
						>
							<Plus size={16} strokeWidth={1.75} />
						</button>
					</div>
					<div class="sessions" {@attach springCollapse(() => closed)}>
						{#each group.sessions as session (session.id)}
							<SessionRow
								{session}
								selected={session.id === app.sessionId}
								people={ws.presenceIn(session.id)}
							/>
						{:else}
							<p class="empty">No sessions yet</p>
						{/each}
					</div>
				</div>
			{:else}
				{#if ws.reposLoaded && ws.mode !== 'loading'}
					<p class="hint">
						{ws.running
							? 'Clone a repository to start a session.'
							: 'Start the machine to see its repositories.'}
					</p>
				{/if}
			{/each}

			{#if ws.archived.length > 0}
				<div class="group">
					<button
						type="button"
						class="repo-main gh-row archived"
						aria-expanded={archivedOpen}
						onclick={() => (archivedOpen = !archivedOpen)}
					>
						<span class="ico" data-align="sidebar-icon">
							<span
								class="chev-lead"
								{@attach springRotate(() => archivedOpen, { rest: 0, on: 90 })}
							>
								<ChevronRight size={16} strokeWidth={1.75} />
							</span>
						</span>
						<span class="label repo-name" data-align="sidebar-label">Archived</span>
						<span class="gh-num count" data-align="sidebar-end">{ws.archived.length}</span>
					</button>
					<div class="sessions" {@attach springCollapse(() => !archivedOpen)}>
						{#each ws.archived as session (session.id)}
							<SessionRow {session} selected={session.id === app.sessionId} />
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<div class="foot">
		<span class="grow"></span>
		<span class="runner" title={idleTitle}>{runnerLabel(machine?.runner)}</span>
		<a
			class="gh-ibtn"
			href="https://orchard.my/docs/greenhouse"
			target="_blank"
			rel="noopener"
			aria-label="Help"
			title="Help"
		>
			<CircleHelp size={16} strokeWidth={1.75} />
		</a>
		<button
			type="button"
			class="gh-ibtn"
			aria-label="Machine settings"
			title={ws && !ws.isOwner ? hostOnly('change machine settings') : 'Machine settings'}
			disabled={!machine || !ws?.isOwner}
			onclick={() => (app.sheet = 'settings')}
		>
			<Settings size={16} strokeWidth={1.75} />
		</button>
	</div>
</nav>

<style>
	.side {
		--row-pad: calc(var(--gh-side-edge) - 0.5rem);
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--gh-sidebar);
	}

	.bar,
	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-bar);
		padding: 0 calc(var(--gh-side-edge) - var(--gh-ibtn-inset));
	}

	.bar {
		border-bottom: 1px solid var(--gh-line);
	}

	.foot {
		border-top: 1px solid var(--gh-line);
	}

	.grow {
		flex: 1;
	}

	.top {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: none;
		padding: 0.75rem 0.5rem;
		border-bottom: 1px solid var(--gh-line);
	}

	.rows {
		display: flex;
		flex-direction: column;
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--gh-row);
		padding: 0 var(--row-pad);
		border-radius: var(--gh-r-row);
		color: var(--gh-muted);
		text-align: left;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.nav:hover:not(:disabled) {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.nav--on {
		background: var(--gh-selected);
		color: var(--gh-text);
		font-weight: 600;
	}

	.nav:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
		min-height: 0;
		padding: 0.5rem 0.5rem 0.75rem;
	}

	.section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex: none;
		height: var(--gh-row);
		margin-bottom: -0.5rem;
		padding: 0 calc(var(--row-pad) - var(--gh-ibtn-inset)) 0 var(--row-pad);
	}

	.section-title {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.section .add {
		opacity: 0;
	}

	.list:hover .section .add,
	.section .add:focus-visible {
		opacity: 1;
	}

	.group {
		display: flex;
		flex-direction: column;
		flex: none;
	}

	.repo {
		position: relative;
		display: flex;
		align-items: center;
	}

	.repo-main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		height: var(--gh-row);
		padding: 0 var(--row-pad);
		border-radius: var(--gh-r-row);
		color: var(--gh-text);
		font-weight: 600;
		text-align: left;
		transition: background-color var(--dur-fast) ease;
	}

	.repo-main:hover {
		background: var(--gh-hover);
	}

	.repo-main.archived {
		color: var(--gh-muted);
		font-weight: 400;
	}

	.avatar {
		display: inline-grid;
		place-items: center;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
		border-radius: 0.25rem;
		background: color-mix(in oklab, var(--hue) 22%, var(--gh-editor));
		color: color-mix(in oklab, var(--hue) 80%, var(--text-default));
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: var(--gh-lh-caption);
	}

	.chev,
	.chev-lead {
		display: inline-grid;
		flex: none;
		color: var(--gh-faint);
	}

	.repo .chev {
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.repo:hover .chev,
	.repo-main:focus-visible .chev {
		opacity: 1;
	}

	.repo-add {
		position: absolute;
		right: calc(var(--row-pad) + var(--gh-glyph) + 0.5rem - var(--gh-ibtn-inset));
		opacity: 0;
	}

	.repo:hover .repo-add,
	.repo-add:focus-visible {
		opacity: 1;
	}

	.sessions {
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.count {
		color: var(--gh-faint);
	}

	.empty,
	.hint {
		margin: 0;
		padding: 0.5rem var(--row-pad) 0.5rem calc(var(--row-pad) + var(--gh-glyph) + 0.5rem);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.hint {
		padding-left: var(--row-pad);
	}

	.runner {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		cursor: default;
	}
</style>
