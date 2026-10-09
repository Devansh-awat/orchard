<script lang="ts">
	import { ChevronRight, House, Plus, Search, Settings } from 'lucide-svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { user } from '$lib/stores';
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
	const handle = $derived($user?.username ? `@${$user.username}` : (self?.name ?? null));
	const face = $derived($user ?? (self ? { id: self.id, imageUrl: self.avatarUrl } : null));

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
		<button type="button" class="search gh-row" onclick={search}>
			<span class="ico"><Search size={16} strokeWidth={1.75} /></span>
			<span class="search-label">Search</span>
			<kbd class="kbd">{mod}K</kbd>
		</button>
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
				<kbd class="gh-kbd hover-kbd">{mod}N</kbd>
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
		{#if face}
			<span class="me" title={self?.name}>
				<span class="gh-face me-face"><Avatar user={face} size={20} alive /></span>
				{#if handle}<span class="me-name" class:me-name--mono={!!$user?.username}>{handle}</span
					>{/if}
			</span>
		{:else}
			<span class="grow"></span>
		{/if}
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
		--row-pad: var(--gh-side-pad);
		--stack-ring: var(--gh-frame);
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
		background: var(--gh-frame);
	}

	.side--compact {
		background: var(--gh-editor);
		--stack-ring: var(--gh-editor);
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

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--gh-list-row);
		padding: 0 calc(var(--row-pad) - 0.25rem) 0 var(--row-pad);
		border-radius: var(--gh-r-control);
		box-shadow: inset 0 0 0 1px var(--gh-line-soft);
		background: var(--gh-hover);
		color: var(--gh-faint);
		text-align: left;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.search:hover {
		color: var(--gh-muted);
		background: var(--gh-selected);
	}

	.search-label {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
	}

	.kbd {
		padding: 0 0.25rem;
		border-radius: var(--radius-xs);
		background: var(--gh-hover);
		color: var(--gh-muted);
		font-family: var(--font-sans);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.rows,
	.group,
	.sessions {
		display: flex;
		flex-direction: column;
		gap: var(--gh-side-gap);
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		width: 100%;
		min-width: 0;
		height: var(--gh-list-row);
		padding: 0 var(--row-pad);
		border-radius: var(--gh-r-control);
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

	.nav--on,
	.nav--on:hover:not(:disabled) {
		background: var(--gh-side-on);
		color: var(--gh-text);
	}

	.nav--on .ico {
		color: var(--gh-side-on-icon);
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

	.hover-kbd {
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.nav:hover:not(:disabled) .hover-kbd,
	.nav:focus-visible .hover-kbd {
		opacity: 1;
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
		font-size: var(--text-micro);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		text-align: left;
		user-select: none;
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
	}

	.head-count {
		flex: none;
		color: var(--gh-faint);
		font-weight: 400;
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
		border-top: 1px solid var(--gh-line-soft);
	}

	.me {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		padding: 0 var(--row-pad) 0 calc(var(--row-pad) - 0.125rem);
		color: var(--gh-muted-strong);
	}

	.me-face {
		--face: 1.25rem;
	}

	.me-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.me-name--mono {
		font-family: var(--gh-mono);
	}

	.grow {
		flex: 1;
	}
</style>
