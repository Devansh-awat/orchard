<script lang="ts">
	import './greenhouse.css';
	import { untrack } from 'svelte';
	import { MessageSquare, GitCompare, PanelsTopLeft } from 'lucide-svelte';
	import { Button, Input, Modal } from '$lib/components/ui';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { toasts } from '$lib/stores';
	import type { SandboxListResponse } from '$lib/types/sandbox';
	import * as api from './api';
	import AddRepoSheet from './AddRepoSheet.svelte';
	import { GreenhouseApp, setGreenhouseApp, type GreenhouseNav } from './app.svelte';
	import CenterBar from './CenterBar.svelte';
	import CenterPane from './CenterPane.svelte';
	import ForkSheet from './ForkSheet.svelte';
	import { setGreenhouseEnv, type GreenhouseEnv } from './env';
	import Home from './Home.svelte';
	import JoinNotice from './JoinNotice.svelte';
	import { LEFT, RIGHT } from './layout.svelte';
	import NewMachineSheet from './NewMachineSheet.svelte';
	import PreviewSheet from './PreviewSheet.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import RightPanel from './RightPanel.svelte';
	import SettingsSheet from './SettingsSheet.svelte';
	import ShareSheet from './ShareSheet.svelte';
	import Sidebar from './Sidebar.svelte';
	import { isLegacy } from './workspace.svelte';
	import type { PersonRef } from './types';

	let {
		env,
		nav,
		list,
		listState,
		self,
		superAdmin = false,
		organizationId = null
	}: {
		env: GreenhouseEnv;
		nav: GreenhouseNav;
		list: SandboxListResponse | null;
		listState: 'loading' | 'ready' | 'disabled' | 'error';
		self: PersonRef | null;
		superAdmin?: boolean;
		organizationId?: string | null;
	} = $props();

	setGreenhouseEnv(untrack(() => env));
	const app = new GreenhouseApp(
		untrack(() => env),
		untrack(() => nav)
	);
	setGreenhouseApp(app);

	const ws = $derived(app.ws);
	const layout = app.layout;

	let width = $state(0);
	let home = $state<Home | null>(null);
	let right = $state<RightPanel | null>(null);
	let homeRepo = $state<string | null>(null);
	let renameOpen = $state(false);
	let renameValue = $state('');
	let startLeft = 0;
	let startRight = 0;

	const mobile = $derived(width > 0 && width < 960);

	$effect(() => {
		app.list = list;
		app.listState = listState;
		app.self = self;
		app.superAdmin = superAdmin;
		app.organizationId = organizationId;
	});

	$effect(() => {
		layout.setUser(self?.id);
	});

	$effect(() => {
		layout.total = width;
	});

	$effect(() => {
		const id = app.machineId;
		untrack(() => app.mount(id));
	});

	$effect(() => {
		void nav.machineId();
		void nav.sessionId();
		void nav.tab();
		app.record();
	});

	$effect(() => {
		const current = ws;
		const session = current?.session ?? null;
		if (!current) return;
		const sid = session && !isLegacy(session) ? session.id : null;
		untrack(() => current.live.join(sid));
	});

	let seeded: string | null = null;
	$effect(() => {
		const current = ws;
		const session = current?.session;
		if (!current || !session || isLegacy(session) || seeded === session.id) return;
		seeded = session.id;
		untrack(() => {
			void api.listComments(current.sandboxId, session.id).then((res) => {
				if (res.ok) current.live.seedComments(res.data.comments ?? []);
			});
			void api.listAuthors(current.sandboxId, session.id).then((res) => {
				if (res.ok) current.live.seedAuthors(res.data.authors ?? {});
			});
		});
	});

	$effect(() => {
		const current = ws;
		if (!current) return;
		current.live.onFollowView = (user) => {
			const tab = user.view?.tab;
			if (tab && tab !== app.nav.tab()) app.nav.go({ tab }, { replace: true });
		};
	});

	$effect(() => {
		const current = ws;
		const tab = current?.activeTab;
		if (!current || !tab || tab.kind === 'file' || tab.kind === 'diff') return;
		untrack(() => current.live.presence({ tab: tab.id }));
	});

	$effect(() => {
		const reason = ws?.live.kicked;
		if (!reason) return;
		untrack(() => {
			toasts.add({ title: reason, color: 'error' });
			app.nav.go({ machine: null, session: null, tab: null });
		});
	});

	function newSession(repo: string | null = null) {
		homeRepo = repo;
		app.goHome();
		queueMicrotask(() => home?.focus());
	}

	function openRename() {
		const session = ws?.session;
		if (!session) return;
		renameValue = session.title;
		renameOpen = true;
	}

	async function commitRename() {
		const session = ws?.session;
		renameOpen = false;
		if (session) await ws?.renameSession(session, renameValue);
	}

	function keydown(event: KeyboardEvent) {
		const mod = event.metaKey || event.ctrlKey;
		if (!mod) return;
		if (event.code === 'KeyB' && !event.shiftKey) {
			event.preventDefault();
			layout.toggle(event.altKey ? 'right' : 'left');
		} else if (event.code === 'KeyJ' && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			layout.toggle('dock');
		} else if (event.code === 'KeyN' && !event.altKey && !event.shiftKey) {
			if (!ws?.canEdit) return;
			event.preventDefault();
			newSession(ws.session?.repo ?? null);
		} else if (event.code === 'Backquote' && !event.altKey) {
			event.preventDefault();
			if (!layout.rightOpen) layout.toggle('right');
			right?.terminal();
		} else if (event.code === 'KeyG' && event.shiftKey) {
			event.preventDefault();
			if (!layout.rightOpen) layout.toggle('right');
			right?.showTab('changes');
		}
	}

	const showRight = $derived(!app.home && layout.rightOpen && !mobile);
	const showLeft = $derived(layout.leftOpen && !mobile);
	const columns = $derived(
		[showLeft ? `${layout.left}px` : null, 'minmax(0, 1fr)', showRight ? `${layout.right}px` : null]
			.filter(Boolean)
			.join(' ')
	);
</script>

<svelte:window onkeydown={keydown} />

<div
	class="gh shell"
	class:shell--dragging={!!layout.dragging}
	class:shell--mobile={mobile}
	bind:clientWidth={width}
	style="grid-template-columns: {mobile ? 'minmax(0, 1fr)' : columns}"
>
	{#if listState === 'disabled'}
		<div class="blank">
			<p class="blank-title">Greenhouse is turned off on this server</p>
			<p class="blank-text">An instance admin can enable it in Admin, Instance settings.</p>
			<Button href="/">Back to Orchard</Button>
		</div>
	{:else if listState === 'loading' && !list}
		<div class="loading">
			<Skeleton height="0.75rem" width="12rem" />
			<Skeleton height="0.75rem" width="18rem" />
		</div>
	{:else if mobile}
		<div class="mobile">
			<div class="mobile-body">
				{#if app.mobilePane === 'sessions' || (!ws?.session && !app.home)}
					<Sidebar onnewsession={newSession} compact />
				{:else if app.home}
					<CenterBar onrename={openRename} compact />
					<Home bind:this={home} initialRepo={homeRepo} />
				{:else if ws && app.mobilePane === 'changes'}
					<RightPanel {ws} showDock={false} />
				{:else if ws}
					<CenterBar onrename={openRename} compact />
					<CenterPane {ws} />
				{/if}
			</div>
			<div class="switcher" role="tablist" aria-label="View">
				<button
					type="button"
					role="tab"
					aria-selected={app.mobilePane === 'sessions'}
					onclick={() => (app.mobilePane = 'sessions')}
				>
					<PanelsTopLeft size={20} strokeWidth={1.75} /> Sessions
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={app.mobilePane === 'chat'}
					onclick={() => (app.mobilePane = 'chat')}
				>
					<MessageSquare size={20} strokeWidth={1.75} /> Chat
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={app.mobilePane === 'changes'}
					disabled={app.home}
					onclick={() => (app.mobilePane = 'changes')}
				>
					<GitCompare size={20} strokeWidth={1.75} /> Changes
				</button>
			</div>
		</div>
	{:else}
		{#if showLeft}
			<div class="col col--left">
				<Sidebar onnewsession={newSession} />
				<div class="grip-anchor grip-anchor--right">
					<ResizeHandle
						label="Resize sidebar"
						value={layout.left}
						min={LEFT.min}
						max={layout.maxLeft()}
						active={layout.dragging === 'left'}
						onstart={() => {
							startLeft = layout.left;
							layout.dragging = 'left';
						}}
						ondrag={(d) => layout.setLeft(startLeft + d)}
						onend={() => {
							layout.dragging = null;
							layout.save();
						}}
						onnudge={(d) => {
							layout.setLeft(layout.left + d);
							layout.save();
						}}
						onreset={() => layout.reset('left')}
					/>
				</div>
			</div>
		{/if}

		<main class="col col--center">
			<CenterBar onrename={openRename} />
			{#if app.home || !ws}
				<Home bind:this={home} initialRepo={homeRepo} />
			{:else if ws.session}
				<CenterPane {ws} />
			{:else if ws.mode === 'loading'}
				<div class="loading">
					<Skeleton height="0.75rem" width="40%" />
					<Skeleton height="0.75rem" width="65%" />
				</div>
			{:else}
				<div class="blank">
					<p class="blank-title">This session is gone</p>
					<p class="blank-text">It may have been deleted, or you no longer have access.</p>
					<button type="button" class="gh-btn" onclick={() => app.goHome()}>Go home</button>
				</div>
			{/if}
		</main>

		{#if showRight && ws}
			<div class="col col--right">
				<div class="grip-anchor grip-anchor--left">
					<ResizeHandle
						label="Resize panel"
						value={layout.right}
						min={RIGHT.min}
						max={layout.maxRight()}
						active={layout.dragging === 'right'}
						onstart={() => {
							startRight = layout.right;
							layout.dragging = 'right';
						}}
						ondrag={(d) => layout.setRight(startRight - d)}
						onend={() => {
							layout.dragging = null;
							layout.save();
						}}
						onnudge={(d) => {
							layout.setRight(layout.right - d);
							layout.save();
						}}
						onreset={() => layout.reset('right')}
					/>
				</div>
				<RightPanel bind:this={right} {ws} />
			</div>
		{/if}
	{/if}

	<NewMachineSheet
		bind:open={() => app.sheet === 'new-machine', (v) => (app.sheet = v ? 'new-machine' : null)}
	/>
	<ShareSheet bind:open={() => app.sheet === 'share', (v) => (app.sheet = v ? 'share' : null)} />
	<SettingsSheet
		bind:open={() => app.sheet === 'settings', (v) => (app.sheet = v ? 'settings' : null)}
	/>
	<AddRepoSheet
		bind:open={() => app.sheet === 'add-repo', (v) => (app.sheet = v ? 'add-repo' : null)}
	/>
	<PreviewSheet
		bind:open={() => app.sheet === 'preview', (v) => (app.sheet = v ? 'preview' : null)}
	/>
	<ForkSheet bind:open={() => app.sheet === 'fork', (v) => (app.sheet = v ? 'fork' : null)} />
	<JoinNotice />
	<Modal bind:open={renameOpen} title="Rename session" size="sm">
		<Input
			bind:value={renameValue}
			aria-label="Session title"
			onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && commitRename()}
		/>
		{#snippet footer()}
			<Button variant="secondary" onclick={() => (renameOpen = false)}>Cancel</Button>
			<Button variant="primary" onclick={commitRename}>Rename</Button>
		{/snippet}
	</Modal>
</div>

<style>
	.shell {
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		height: 100dvh;
		width: 100%;
		overflow: hidden;
		background: var(--gh-editor);
	}

	.shell--dragging {
		cursor: col-resize;
		user-select: none;
	}

	.col {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.col--left {
		border-right: 1px solid var(--gh-line);
	}

	.col--right {
		border-left: 1px solid var(--gh-line);
	}

	.grip-anchor {
		position: absolute;
		top: 0;
		bottom: 0;
		z-index: 5;
	}

	.grip-anchor--right {
		right: 0;
	}

	.grip-anchor--left {
		left: 0;
	}

	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 3rem var(--gh-edge);
	}

	.blank {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		flex: 1;
		height: 100%;
		padding: 2rem;
		text-align: center;
	}

	.blank-title {
		margin: 0;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
	}

	.blank-text {
		margin: 0 0 0.5rem;
		color: var(--gh-muted);
	}

	.mobile {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	.mobile-body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}

	.switcher {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		flex: none;
		height: calc(3rem + env(safe-area-inset-bottom));
		padding-bottom: env(safe-area-inset-bottom);
		border-top: 1px solid var(--gh-line);
		background: var(--gh-sidebar);
	}

	.switcher button {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.switcher button[aria-selected='true'] {
		color: var(--gh-text);
		font-weight: 600;
	}

	.switcher button:disabled {
		opacity: 0.4;
	}
</style>
