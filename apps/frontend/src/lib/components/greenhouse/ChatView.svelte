<script lang="ts">
	import WakeUp from './WakeUp.svelte';
	import { untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Eye, Play } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { ChatPanel, PendingDock, Transcript } from '$lib/components/sandbox/chat';
	import NewChat from '$lib/components/sandbox/chat/NewChat.svelte';
	import {
		chatTranscriptFile,
		textFile,
		type ContextChat,
		type ContextPlan
	} from '$lib/components/sandbox/chat/context-attach';
	import { isPlanFile, planLabel } from '$lib/components/sandbox/chat/steps';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { sandboxBootQueryOptions } from '$lib/queries/sandboxes';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { GreenhouseCommands } from './chat-commands.svelte';
	import SessionPreparing from './SessionPreparing.svelte';
	import { isPreparing, type MachineWorkspace } from './workspace.svelte';

	let { ws, visible = true }: { ws: MachineWorkspace; visible?: boolean } = $props();

	const app = getGreenhouseApp();
	const store = $derived(ws.store);
	const commands = $derived(new GreenhouseCommands(ws, app));
	const machine = $derived(ws.machine);
	const status = $derived(machine?.status ?? 'stopped');
	const harness = $derived(ws.env.harness === true);

	const bootQuery = createQuery(() =>
		sandboxBootQueryOptions(
			ws.sandboxId,
			!harness && ws.isOwner && !!machine && status !== 'stopped' && status !== 'error'
		)
	);
	const bootSettled = $derived(harness || bootQuery.isFetched || !ws.isOwner);
	const ready = $derived(
		status === 'running' &&
			(harness || !ws.isOwner || bootQuery.isError || bootQuery.data?.ready === true)
	);
	const booting = $derived(!ready && status !== 'stopped' && status !== 'error');
	const pending = $derived(status === 'running' && !bootSettled);

	$effect(() => {
		if (!ready) return;
		const current = store;
		untrack(() => {
			void current.connect();
		});
		return () => current.pause();
	});

	$effect(() => {
		store.directory = ws.session?.worktreePath ?? null;
	});

	$effect(() => {
		if (!ws.canEdit || store.connection !== 'ready') return;
		const directory = store.agentDirectory();
		const chatId = store.activeId;
		const current = commands;
		untrack(() => {
			void current.load(directory, chatId);
		});
	});

	$effect(() => {
		const list = ws.live.comments;
		store.comments = list.map((c) => ({
			id: c.id,
			author: { id: c.author.id, name: c.author.name, avatarUrl: c.author.avatarUrl ?? null },
			body: c.body,
			createdAt: c.createdAt,
			sessionId: c.chatId
		}));
	});

	let selected: string | null = null;
	$effect(() => {
		const chatId = ws.activeChatId;
		if (!chatId || chatId === selected) return;
		if (store.connection !== 'ready' || !store.settled) return;
		selected = chatId;
		untrack(() => {
			void store.selectSession(chatId);
		});
	});

	const session = $derived(ws.session);
	const staged = $derived(isPreparing(session));
	const launch = $derived(session ? (ws.launches.get(session.id) ?? null) : null);
	const launchPrompt = $derived(launch?.prompt?.trim() || null);
	const landed = $derived.by(() => {
		if (!launchPrompt) return true;
		const chatId = ws.activeChatId;
		const thread = store.active;
		if (!chatId || store.activeId !== chatId || !thread?.loaded) return false;
		return thread.entries.some((e) => e.kind === 'user');
	});
	const preparing = $derived(!!session && (staged || !landed));
	let retrying = $state(false);

	$effect(() => {
		const sid = session?.id;
		if (!sid || !launch || staged) return;
		if (landed) {
			untrack(() => ws.launches.delete(sid));
			return;
		}
		const timer = setTimeout(() => ws.launches.delete(sid), 30_000);
		return () => clearTimeout(timer);
	});

	async function retry() {
		if (!session || retrying) return;
		retrying = true;
		try {
			await ws.retrySession(session);
		} finally {
			retrying = false;
		}
	}

	async function remove() {
		if (!session || retrying) return;
		retrying = true;
		try {
			await ws.deleteSession(session, true);
		} finally {
			retrying = false;
		}
	}

	let loadedFor: string | null = null;
	$effect(() => {
		const sid = ws.sessionId;
		const key = sid ? `${sid}:${ready}:${staged}` : null;
		if (!sid || key === loadedFor) return;
		const switched = !loadedFor?.startsWith(`${sid}:`);
		loadedFor = key;
		if (switched) selected = null;
		if (staged) return;
		untrack(() => {
			void ws.loadChats(sid);
			void ws.refreshChanges(sid);
		});
	});

	$effect(() => {
		const sid = ws.sessionId;
		if (!ready || staged || !sid || ws.pendingChat !== sid) return;
		untrack(() => {
			ws.pendingChat = null;
			void ws.newChat();
		});
	});

	let sending = false;
	$effect(() => {
		const sid = ws.sessionId;
		if (!sid || sending) return;
		const prompt = ws.pendingPrompts.get(sid);
		if (!prompt) return;
		if (store.connection !== 'ready' || !store.settled) return;
		const chatId = ws.activeChatId;
		if (chatId && store.activeId !== chatId) return;
		sending = true;
		untrack(() => {
			ws.pendingPrompts.delete(sid);
			void ws.queuePrompt(prompt).finally(() => (sending = false));
		});
	});

	const PLANS_DIR = '.opencode/plans';
	const fresh = $derived(
		store.settled && !!store.active && !store.active.loading && store.feed.length === 0
	);

	const contextChats = $derived.by((): ContextChat[] => {
		if (!fresh) return [];
		const active = store.activeId;
		const worktree = session?.worktreePath ?? null;
		const own: ContextChat[] = ws.chatList
			.filter((chat) => chat.id !== active)
			.map((chat) => ({
				id: chat.id,
				title: chat.title || 'Chat',
				directory: worktree,
				hint: 'This branch'
			}));
		const seen = new Set<string | null>([active, ...own.map((chat) => chat.id)]);
		const recent: ContextChat[] = store.sessions
			.filter((s) => !s.pending && !seen.has(s.id) && !/^new (session|chat)\b/i.test(s.title))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((s) => ({
				id: s.id,
				title: s.title || 'Chat',
				directory: s.directory,
				hint: s.repo ?? undefined
			}));
		return [...own, ...recent];
	});

	let plans = $state.raw<ContextPlan[]>([]);
	let plansFor: string | null = null;
	$effect(() => {
		const current = session;
		if (!current || !fresh || !ws.canEdit) return;
		const key = `${current.id}:${store.activeId}`;
		if (key === plansFor) return;
		plansFor = key;
		untrack(() => {
			plans = [];
			void loadPlans(current.worktreePath, key);
		});
	});

	async function loadPlans(worktree: string, key: string) {
		const nodes = await api.listDir(ws.sandboxId, worktree, PLANS_DIR);
		if (plansFor !== key) return;
		plans = nodes
			.filter((node) => node.type === 'file' && isPlanFile(node.name))
			.sort((a, b) => b.name.localeCompare(a.name))
			.map((node) => ({
				path: `${PLANS_DIR}/${node.name}`,
				name: node.name,
				label: planLabel(node.name)
			}));
	}

	async function attachChat(chat: ContextChat) {
		await store.addFiles([await chatTranscriptFile(ws.sandboxId, chat)]);
	}

	async function attachPlan(plan: ContextPlan) {
		const current = session;
		if (!current) return;
		const content = await api.readFile(ws.sandboxId, { session: current.id }, plan.path);
		await store.addFiles([textFile(plan.name, content)]);
	}

	function onComment(text: string) {
		const chatId = ws.activeChatId;
		if (chatId) return ws.sendComment(chatId, text);
	}
</script>

<div class="chat" class:chat--hidden={!visible}>
	{#if pending}
		<div class="gate gate--skeleton" aria-hidden="true">
			<Skeleton height="0.75rem" width="45%" />
			<Skeleton height="0.75rem" width="82%" />
			<Skeleton height="0.75rem" width="68%" />
		</div>
	{:else if !ready}
		<div class="gate">
			{#if booting}
				<WakeUp boot={bootQuery.data ?? null} {status} />
			{:else}
				<p class="gate-title">{machine?.name ?? 'This machine'} is stopped</p>
				<p class="gate-text">Start it to pick up where the agent left off.</p>
				<button
					type="button"
					class="gh-btn gh-btn--primary"
					disabled={!ws.canStart || !!ws.busy}
					onclick={() => ws.lifecycle('start')}
				>
					<Play size={14} /> Start machine
				</button>
			{/if}
		</div>
	{:else if preparing}
		<SessionPreparing
			prompt={launchPrompt}
			author={ws.host.self()}
			time={launch?.at ?? null}
			phase={session?.preparing ? 'worktree' : 'agent'}
			error={session?.prepareError ?? null}
			canEdit={ws.canEdit}
			busy={retrying}
			onretry={retry}
			onremove={remove}
		/>
	{:else if ws.canEdit}
		<ChatPanel
			{store}
			tabs={false}
			remoteDrafts={ws.remoteDrafts}
			{onComment}
			commands={commands.list}
			onCommand={(command, args, alias) => commands.run(command, args, alias)}
			options={(command) => commands.options(command)}
		>
			{#snippet empty()}
				<NewChat
					branch={session?.branch ?? null}
					chats={contextChats}
					{plans}
					onchat={attachChat}
					onplan={attachPlan}
				/>
			{/snippet}
		</ChatPanel>
	{:else}
		<Transcript {store} />
		<div class="viewer">
			<PendingDock {store} readonly />
			<div class="viewer-box">
				<Eye size={14} />
				<span
					>You joined as a read-only guest. Ask the host for guest access to prompt the agent.</span
				>
			</div>
		</div>
	{/if}
</div>

<ConfirmModal
	bind:open={() => !!commands.creating, (v) => !v && (commands.creating = null)}
	title="Create AGENTS.md?"
	description="This worktree has no AGENTS.md or CLAUDE.md yet. Create an empty AGENTS.md and open it?"
	confirmLabel="Create"
	danger={false}
	onconfirm={() => commands.createMemory()}
	oncancel={() => (commands.creating = null)}
/>

<style>
	.chat {
		--chat-gutter: 2rem;
		--chat-inset: 1rem;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
		container: chat-pane / inline-size;
	}

	.chat--hidden {
		display: none;
	}

	.gate {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 2.5rem 1rem;
	}

	.gate--skeleton {
		align-items: stretch;
		justify-content: flex-end;
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		margin: 0 auto;
		padding: 2rem calc(var(--chat-gutter) + var(--chat-inset));
	}

	@container chat-pane (min-width: 48rem) {
		.gate--skeleton,
		.viewer {
			--chat-inset: 1.5rem;
		}
	}

	.gate-title {
		margin: 0;
		font-size: var(--text-callout);
		font-weight: 600;
		color: var(--gh-text);
	}

	.gate-text {
		margin: 0 0 0.5rem;
		color: var(--gh-muted);
	}

	.viewer {
		flex: none;
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 calc(var(--chat-gutter) + var(--chat-inset)) 1rem;
	}

	.viewer-box {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.875rem 1rem;
		border-radius: var(--radius-lg);
		border: 1px dashed var(--gh-composer-edge);
		color: var(--gh-muted);
	}
</style>
