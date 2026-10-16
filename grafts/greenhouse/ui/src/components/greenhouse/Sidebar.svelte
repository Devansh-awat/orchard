<script lang="ts">
	import {
		ChevronRight,
		Ellipsis,
		House,
		Plus,
		Search,
		Settings,
		LoaderCircle,
		Play,
		SmilePlus,
		Trash2
	} from 'lucide-svelte';
	import ConfirmModal from '@orchardlabs/graft-ui/components/ConfirmModal.svelte';
	import Avatar from '@orchardlabs/graft-ui/components/ui/Avatar.svelte';
	import MenuItem from '@orchardlabs/graft-ui/components/ui/MenuItem.svelte';
	import { user } from '../../host/stores';
	import { springCollapse, springRotate } from '@orchardlabs/graft-ui/utils/motion.svelte';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import MachineMenu from './MachineMenu.svelte';
	import RepoIcon from './RepoIcon.svelte';
	import RepoIconPicker from './RepoIconPicker.svelte';
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

	const asleepStatus = $derived(ws?.machine?.status ?? 'stopped');

	const cloneBlocked = $derived(ws?.isOwner ? undefined : hostOnly('clone repositories'));

	function search() {
		window.dispatchEvent(new Event('open-quick-search'));
	}

	let menuRepo = $state<string | null>(null);
	let menuOpen = $state(false);
	let menuPlacement = $state<'bottom-start' | 'bottom-end'>('bottom-start');
	let mx = $state(0);
	let my = $state(0);
	let headRect: DOMRect | null = null;
	let menuToggle = $state<HTMLElement | null>(null);

	let pickRepo = $state<string | null>(null);
	let pickerOpen = $state(false);
	let px = $state(0);
	let py = $state(0);

	const picking = $derived(ws?.repos.find((r) => r.name === pickRepo) ?? null);
	const iconBlocked = $derived(ws?.running ? undefined : 'Start the machine to change the icon');

	function headOf(event: MouseEvent): DOMRect | null {
		const head = (event.currentTarget as HTMLElement).closest('.head');
		return head ? head.getBoundingClientRect() : null;
	}

	function repoContext(event: MouseEvent, name: string) {
		if (!ws?.canEdit) return;
		event.preventDefault();
		headRect = headOf(event);
		menuRepo = name;
		menuToggle = null;
		menuPlacement = 'bottom-start';
		mx = event.clientX;
		my = event.clientY;
		menuOpen = true;
	}

	function repoMore(event: MouseEvent, name: string) {
		const button = event.currentTarget as HTMLElement;
		if (menuOpen && menuRepo === name && menuToggle === button) {
			menuOpen = false;
			return;
		}
		headRect = headOf(event);
		const rect = button.getBoundingClientRect();
		menuToggle = button;
		menuRepo = name;
		menuPlacement = 'bottom-end';
		mx = rect.right;
		my = rect.bottom + 10;
		menuOpen = true;
	}

	let doomedRepo = $state<string | null>(null);
	const doomedLinked = $derived.by(() => {
		const repo = doomedRepo ? ws?.repos.find((r) => r.name === doomedRepo) : null;
		return repo?.linked && repo.path ? api.displayPath(repo.path) : null;
	});
	const doomedSessions = $derived(
		doomedRepo ? (ws?.sessions.filter((s) => s.repo === doomedRepo).length ?? 0) : 0
	);
	const removeBlocked = $derived(
		!ws?.isOwner
			? hostOnly('remove repositories')
			: !ws.running
				? 'Start the machine to remove a repository'
				: undefined
	);

	let removeOpen = $state(false);

	function askRemove() {
		const name = menuRepo;
		menuOpen = false;
		if (!name) return;
		doomedRepo = name;
		removeOpen = true;
	}

	function confirmRemove() {
		if (doomedRepo) void ws?.removeRepo(doomedRepo);
	}

	function changeIcon() {
		const name = menuRepo;
		menuOpen = false;
		if (!name) return;
		pickRepo = name;
		px = headRect ? headRect.left : mx;
		py = headRect ? headRect.bottom + 4 : my;
		requestAnimationFrame(() => (pickerOpen = true));
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

	<div class="list gh-scroll" role="tree" aria-label="Sessions" data-tour="repos">
		{#if ws?.lifecycleOnly}
			<p class="hint">Only the host and people they invite can see what is on this machine.</p>
		{:else if ws && !ws.running}
			{#if !app.home}
				<div class="asleep" role="status">
					<p class="asleep-title">
						{asleepStatus === 'stopped' || asleepStatus === 'error'
							? `${ws.machine?.name ?? 'This machine'} is asleep`
							: `Starting ${ws.machine?.name ?? 'the machine'}…`}
					</p>
					<p class="asleep-text">Start it to see its repositories and sessions.</p>
					{#if asleepStatus === 'stopped' || asleepStatus === 'error'}
						<button
							type="button"
							class="gh-btn gh-btn--primary asleep-start"
							disabled={!ws.canStart || !!ws.busy}
							title={ws.canStart ? undefined : 'Read-only guests cannot start this machine'}
							onclick={() => ws.lifecycle('start')}
						>
							<Play size={14} strokeWidth={1.75} /> Start machine
						</button>
					{/if}
				</div>
			{/if}
		{:else if ws}
			{#each ws.groups as group (group.name)}
				{@const closed = collapsed[group.name] ?? false}
				<div class="group" role="group" aria-label={group.name}>
					<div
						class="head"
						class:head--closed={closed}
						class:head--menu={menuOpen && menuRepo === group.name}
						role="presentation"
						oncontextmenu={(e) => group.repo && repoContext(e, group.name)}
					>
						<button
							type="button"
							class="head-main gh-row"
							aria-expanded={!closed}
							onclick={() => (collapsed[group.name] = !closed)}
						>
							<span class="head-icon"
								><RepoIcon
									name={group.name}
									github={group.repo?.github}
									icon={group.repo?.icon}
								/></span
							>
							<span class="head-name">{group.name}</span>
							{#if closed && group.sessions.length > 0}
								<span class="head-count">{group.sessions.length}</span>
							{/if}
							<span class="chev" {@attach springRotate(() => !closed, { rest: 0, on: 90 })}>
								<ChevronRight size={14} strokeWidth={1.75} />
							</span>
						</button>
						<div class="head-actions">
							{#if ws.canEdit && group.repo}
								<button
									type="button"
									class="gh-ibtn"
									aria-label="More actions for {group.name}"
									title="More actions"
									aria-haspopup="menu"
									aria-expanded={menuOpen && menuRepo === group.name}
									onclick={(e) => repoMore(e, group.name)}
								>
									<Ellipsis size={16} strokeWidth={1.75} />
								</button>
							{/if}
							<button
								type="button"
								class="gh-ibtn"
								aria-label="New session in {group.name}"
								title={ws.canEdit ? `New session in ${group.name}` : VIEWER_ONLY}
								disabled={!ws.canEdit}
								onclick={() => onnewsession(group.name)}
							>
								<Plus size={16} strokeWidth={1.75} />
							</button>
						</div>
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
					<p class="hint">Clone a repository to start a session.</p>
				{/if}
			{/each}

			{#each [...ws.cloning].filter((name) => !ws.repos.some((r) => r.name === name)) as name (name)}
				<div class="nav nav--quiet gh-row" role="status">
					<span class="ico animate-spin" data-motion="progress"
						><LoaderCircle size={16} strokeWidth={1.75} /></span
					>
					<span class="label">Cloning {name}…</span>
				</div>
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

	{#if ws?.canEdit}
		<ContextMenu bind:open={menuOpen} x={mx} y={my} placement={menuPlacement} toggle={menuToggle}>
			<MenuItem onclick={() => menuRepo && onnewsession(menuRepo)}>
				<Plus size={14} /> New session
			</MenuItem>
			<MenuItem onclick={changeIcon} disabled={!!iconBlocked} title={iconBlocked}>
				<SmilePlus size={14} /> Change icon…
			</MenuItem>
			<MenuItem danger onclick={askRemove} disabled={!!removeBlocked} title={removeBlocked}>
				<Trash2 size={14} /> Remove repository…
			</MenuItem>
		</ContextMenu>
		<ConfirmModal
			bind:open={removeOpen}
			title="Remove {doomedRepo}?"
			description={doomedLinked
				? `Removes it from Greenhouse${doomedSessions > 0 ? ` with its ${doomedSessions} ${doomedSessions === 1 ? 'session' : 'sessions'}` : ''}. The folder at ${doomedLinked} stays on this machine.`
				: doomedSessions > 0
					? `Deletes the clone and its ${doomedSessions} ${doomedSessions === 1 ? 'session' : 'sessions'} from this machine. Anything not pushed is lost.`
					: 'Deletes the clone from this machine. Anything not pushed is lost.'}
			confirmLabel="Remove"
			danger
			onconfirm={confirmRemove}
			oncancel={() => {}}
		/>
		{#if picking}
			<RepoIconPicker
				bind:open={pickerOpen}
				x={px}
				y={py}
				repo={picking}
				onpick={(icon) => ws?.setRepoIcon(picking.name, icon)}
			/>
		{/if}
	{/if}

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

	.head-icon {
		display: inline-grid;
		flex: none;
		margin-right: 0.25rem;
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

	.head-actions {
		position: absolute;
		top: 0;
		bottom: 0;
		right: calc(var(--row-pad) - var(--gh-ibtn-inset));
		display: flex;
		align-items: center;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-fast) ease;
	}

	.head:hover .head-actions,
	.head:focus-within .head-actions,
	.head--menu .head-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.head:hover .head-main,
	.head:focus-within .head-main,
	.head--menu .head-main {
		padding-right: calc(var(--gh-icon) * 2 + var(--row-pad) - var(--gh-ibtn-inset));
	}

	.head--menu .head-main {
		color: var(--gh-text);
	}

	@media (hover: none) {
		.head-actions {
			opacity: 1;
			pointer-events: auto;
		}

		.head-main {
			padding-right: calc(var(--gh-icon) * 2 + var(--row-pad) - var(--gh-ibtn-inset));
		}
	}

	.sessions {
		overflow: hidden;
	}

	.asleep {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0.25rem 0.5rem 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-card, 0.625rem);
		background: var(--bg-raised);
	}

	.asleep-title {
		margin: 0;
		font-weight: 600;
		color: var(--gh-text);
	}

	.asleep-text {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.asleep-start {
		align-self: flex-start;
		margin-top: 0.5rem;
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
