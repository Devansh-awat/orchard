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

	let { onnewsession }: { onnewsession: (repo?: string | null) => void } = $props();

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
	<div class="bar">
		<button
			type="button"
			class="gh-ibtn"
			aria-label="Hide sidebar"
			title="Hide sidebar ({mod}B)"
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

	<div class="top">
		<div class="machine"><MachineMenu /></div>
		<button type="button" class="nav gh-row" class:nav--on={app.home} onclick={() => app.goHome()}>
			<House size={16} strokeWidth={1.75} />
			<span>Home</span>
		</button>
		<button
			type="button"
			class="nav gh-row"
			onclick={() => onnewsession(null)}
			disabled={ws ? !ws.canEdit : false}
			title={ws && !ws.canEdit ? VIEWER_ONLY : undefined}
		>
			<Plus size={16} strokeWidth={1.75} />
			<span>New session</span>
			<span class="gh-kbd">{mod}N</span>
		</button>
		<button type="button" class="nav gh-row" onclick={search}>
			<Search size={16} strokeWidth={1.75} />
			<span>Search</span>
			<span class="gh-kbd">{mod}K</span>
		</button>
	</div>

	<div class="list gh-scroll" role="tree" aria-label="Repositories">
		<div class="section">
			<span>Repositories</span>
			<button
				type="button"
				class="gh-ibtn add"
				aria-label="Add repository"
				title={ws && !ws.canEdit ? VIEWER_ONLY : 'Clone a repository onto this machine'}
				disabled={!ws?.canEdit || !ws?.running}
				onclick={() => (app.sheet = 'add-repo')}
			>
				<Plus size={14} strokeWidth={1.75} />
			</button>
		</div>

		{#if ws}
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
							<span class="avatar" style="--hue: var({repoHue(group.name)})">
								{repoInitial(group.name)}
							</span>
							<span class="repo-name">{group.name}</span>
							<span class="chev" {@attach springRotate(() => !closed, { rest: 0, on: 90 })}>
								<ChevronRight size={14} strokeWidth={1.75} />
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
							<Plus size={14} strokeWidth={1.75} />
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
						<span class="chev" {@attach springRotate(() => archivedOpen, { rest: 0, on: 90 })}>
							<ChevronRight size={14} strokeWidth={1.75} />
						</span>
						<span class="repo-name">Archived</span>
						<span class="gh-num count">{ws.archived.length}</span>
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
		<span class="runner" title={idleTitle}>{runnerLabel(machine?.runner)}</span>
		<span class="grow"></span>
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
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--gh-sidebar);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex: none;
		height: var(--gh-bar);
		padding: 0 0.5rem;
	}

	.grow {
		flex: 1;
	}

	.top {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		flex: none;
		padding: 0.25rem 0.5rem 0.5rem;
		border-bottom: 1px solid var(--gh-line);
	}

	.machine {
		display: flex;
		min-width: 0;
		margin-bottom: 0.25rem;
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: var(--gh-row);
		padding: 0 0.5rem;
		border-radius: var(--radius-xs);
		color: var(--gh-muted);
		text-align: left;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.nav span:first-of-type {
		flex: 1;
	}

	.nav:hover:not(:disabled) {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.nav--on {
		background: var(--gh-selected);
		color: var(--gh-text);
		font-weight: 500;
	}

	.nav:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.list {
		flex: 1;
		min-height: 0;
		padding: 0.5rem;
	}

	.section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--gh-row);
		padding: 0 0.25rem 0 0.5rem;
		font-size: var(--gh-caption);
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
		margin-bottom: 0.25rem;
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
		padding: 0 0.5rem;
		border-radius: var(--radius-xs);
		color: var(--gh-text);
		font-weight: 500;
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
		flex: none;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 0.3125rem;
		background: color-mix(in oklab, var(--hue) 22%, var(--gh-editor));
		color: color-mix(in oklab, var(--hue) 80%, var(--text-default));
		font-size: var(--text-micro);
		font-weight: 700;
		line-height: 1;
	}

	.repo-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.chev {
		display: inline-grid;
		flex: none;
		color: var(--gh-faint);
	}

	.repo .chev {
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.repo:hover .chev {
		opacity: 1;
	}

	.repo-add {
		position: absolute;
		right: 1.75rem;
		opacity: 0;
	}

	.repo:hover .repo-add,
	.repo-add:focus-visible {
		opacity: 1;
	}

	.sessions {
		display: flex;
		flex-direction: column;
		gap: 1px;
		overflow: hidden;
	}

	.count {
		color: var(--gh-faint);
	}

	.empty,
	.hint {
		margin: 0;
		padding: 0.375rem 0.75rem 0.5rem 2.125rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.hint {
		padding-left: 0.5rem;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex: none;
		height: var(--gh-bar);
		padding: 0 0.5rem;
		border-top: 1px solid var(--gh-line);
	}

	.runner {
		display: inline-flex;
		align-items: center;
		height: 1.25rem;
		padding: 0 0.4375rem;
		border-radius: var(--radius-xs);
		border: 1px dashed var(--gh-line);
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		letter-spacing: 0.02em;
		cursor: default;
	}
</style>
