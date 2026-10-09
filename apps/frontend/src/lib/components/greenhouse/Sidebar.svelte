<script lang="ts">
	import { ChevronRight, CircleHelp, House, Plus, Search, Settings } from 'lucide-svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { springCollapse, springRotate } from '$lib/utils/motion.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import MachineMenu from './MachineMenu.svelte';
	import SessionRow from './SessionRow.svelte';
	import { modKey } from './format';
	import { VIEWER_ONLY, hostOnly } from './workspace.svelte';

	let {
		onnewsession,
		compact = false
	}: { onnewsession: (repo?: string | null) => void; compact?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const self = $derived(app.self);
	const mod = modKey();

	let collapsed = $state<Record<string, boolean>>({});
	let archivedOpen = $state(false);
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const cloneBlocked = $derived(
		!ws?.isOwner
			? hostOnly('clone repositories')
			: !ws.running
				? 'Start the machine to clone a repository'
				: undefined
	);

	function search() {
		window.dispatchEvent(new Event('open-quick-search'));
	}
</script>

<nav class="side" class:side--compact={compact} aria-label="Greenhouse">
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
				<span class="ico"><House size={16} strokeWidth={1.75} /></span>
				<span class="label">Home</span>
			</button>
			<button
				type="button"
				class="nav gh-row"
				onclick={() => onnewsession(null)}
				disabled={ws ? !ws.canEdit : false}
				title={ws && !ws.canEdit ? VIEWER_ONLY : undefined}
			>
				<span class="ico"><Plus size={16} strokeWidth={1.75} /></span>
				<span class="label">New session</span>
				<span class="gh-kbd">{mod}N</span>
			</button>
			<button type="button" class="nav gh-row" onclick={search}>
				<span class="ico"><Search size={16} strokeWidth={1.75} /></span>
				<span class="label">Search</span>
				<span class="gh-kbd">{mod}K</span>
			</button>
		</div>
	</div>

	<div class="list gh-scroll" role="tree" aria-label="Sessions">
		{#if ws?.lifecycleOnly}
			<p class="hint">Only the host and people they invite can see what is on this machine.</p>
		{:else if ws}
			{#each ws.groups as group (group.name)}
				{@const closed = collapsed[group.name] ?? false}
				<div class="group" role="group" aria-label={group.name}>
					<div class="head" class:head--closed={closed}>
						<button
							type="button"
							class="head-main gh-row"
							aria-expanded={!closed}
							onclick={() => (collapsed[group.name] = !closed)}
						>
							<span class="head-name">{group.name}</span>
							{#if closed && group.sessions.length > 0}
								<span class="head-count">{group.sessions.length}</span>
							{/if}
							<span class="chev" {@attach springRotate(() => !closed, { rest: 0, on: 90 })}>
								<ChevronRight size={14} strokeWidth={1.75} />
							</span>
						</button>
						<button
							type="button"
							class="gh-ibtn head-add"
							aria-label="New session in {group.name}"
							title={ws.canEdit ? `New session in ${group.name}` : VIEWER_ONLY}
							disabled={!ws.canEdit}
							onclick={() => onnewsession(group.name)}
						>
							<Plus size={16} strokeWidth={1.75} />
						</button>
					</div>
					<div class="sessions" inert={closed} {@attach springCollapse(() => closed)}>
						{#each group.sessions as session (session.id)}
							<SessionRow
								{session}
								{now}
								selected={session.id === app.sessionId}
								people={ws.presenceIn(session.id)}
							/>
						{:else}
							<button
								type="button"
								class="nav nav--quiet gh-row"
								disabled={!ws.canEdit}
								title={ws.canEdit ? undefined : VIEWER_ONLY}
								onclick={() => onnewsession(group.name)}
							>
								<span class="ico"><Plus size={16} strokeWidth={1.75} /></span>
								<span class="label">New session</span>
							</button>
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

			<button
				type="button"
				class="nav nav--quiet gh-row"
				disabled={!!cloneBlocked}
				title={cloneBlocked}
				onclick={() => (app.sheet = 'add-repo')}
			>
				<span class="ico"><Plus size={16} strokeWidth={1.75} /></span>
				<span class="label">Add repository</span>
			</button>

			{#if ws.archived.length > 0}
				<div class="group">
					<div class="head" class:head--closed={!archivedOpen}>
						<button
							type="button"
							class="head-main gh-row"
							aria-expanded={archivedOpen}
							onclick={() => (archivedOpen = !archivedOpen)}
						>
							<span class="head-name">Archived</span>
							{#if !archivedOpen}<span class="head-count">{ws.archived.length}</span>{/if}
							<span class="chev" {@attach springRotate(() => archivedOpen, { rest: 0, on: 90 })}>
								<ChevronRight size={14} strokeWidth={1.75} />
							</span>
						</button>
					</div>
					<div class="sessions" inert={!archivedOpen} {@attach springCollapse(() => !archivedOpen)}>
						{#each ws.archived as session (session.id)}
							<SessionRow {session} {now} selected={session.id === app.sessionId} />
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<div class="foot">
		{#if self}
			<span class="me">
				<span class="ico"
					><span class="gh-face face"
						><Avatar
							user={{ id: self.id, name: self.name, imageUrl: self.avatarUrl }}
							size={20}
						/></span
					></span
				>
				<span class="label">{self.name}</span>
			</span>
		{/if}
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
			aria-label="Settings"
			title="Settings ({mod},)"
			onclick={() => app.openSettings()}
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
		background: var(--gh-frame);
	}

	.top {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: none;
		padding: 0.25rem 0.5rem 0.75rem;
	}

	.side--compact .top {
		padding-top: 0.5rem;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: var(--gh-row-gap);
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-row);
		padding: 0 var(--row-pad);
		border-radius: var(--gh-r-row);
		color: var(--gh-muted-strong);
		text-align: left;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
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

	.nav--on:hover:not(:disabled) {
		background: var(--gh-selected);
	}

	.nav:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.nav--quiet {
		color: var(--gh-faint);
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

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		flex: 1;
		min-height: 0;
		padding: 0.25rem 0.5rem 0.75rem;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: var(--gh-row-gap);
		flex: none;
	}

	.head {
		position: relative;
		display: flex;
		align-items: center;
	}

	.head-main {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: 1;
		min-width: 0;
		height: var(--gh-list-row);
		padding: 0 var(--row-pad);
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		text-align: left;
		transition: color var(--dur-fast) ease;
	}

	.head-main:hover {
		color: var(--gh-text);
	}

	.head-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
	}

	.head-count {
		flex: none;
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.chev {
		display: inline-grid;
		flex: none;
		color: var(--gh-faint);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.head:hover .chev,
	.head-main:focus-visible .chev,
	.head--closed .chev {
		opacity: 1;
	}

	.head-add {
		position: absolute;
		right: calc(var(--row-pad) - var(--gh-ibtn-inset));
		opacity: 0;
		transition:
			opacity var(--dur-fast) ease,
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.head:hover .head-add,
	.head-add:focus-visible {
		opacity: 1;
	}

	.sessions {
		display: flex;
		flex-direction: column;
		gap: var(--gh-row-gap);
		overflow: hidden;
	}

	.hint {
		margin: 0;
		padding: 0.5rem var(--row-pad);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		height: var(--gh-titlebar);
		padding: 0 calc(var(--gh-side-edge) - var(--gh-ibtn-inset)) 0 0.5rem;
	}

	.me {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 0 1 auto;
		min-width: 0;
		padding: 0 var(--row-pad);
		color: var(--gh-text);
	}

	.face {
		--face: 1.25rem;
	}

	.grow {
		flex: 1;
	}
</style>
