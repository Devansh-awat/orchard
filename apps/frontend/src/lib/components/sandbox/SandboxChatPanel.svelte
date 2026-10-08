<script lang="ts">
	import { untrack } from 'svelte';
	import { Play } from 'lucide-svelte';
	import { user } from '$lib/stores';
	import { Button, Skeleton } from '$lib/components/ui';
	import SandboxBootProgress from './SandboxBootProgress.svelte';
	import { ocDirectory } from './opencode';
	import {
		ChatSessionStore,
		type ChatAuthor,
		type ChatComment,
		type RemoteDraft
	} from './chat/session-store.svelte';
	import ChatPanel from './chat/ChatPanel.svelte';
	import type { Sandbox, SandboxBoot, SandboxRepo } from '$lib/types/sandbox';

	let {
		sandbox,
		selectedRepo = $bindable(null),
		sessionId = $bindable(null),
		directory = null,
		starting = false,
		owned = true,
		ready = false,
		booting = false,
		bootPending = false,
		boot = null,
		comments = [],
		remoteDrafts = [],
		authorOf = undefined,
		beforePrompt = undefined,
		onDraftChange = undefined,
		onComment = undefined,
		onstart,
		onturndone
	}: {
		sandbox: Sandbox;
		repos?: SandboxRepo[];
		selectedRepo?: string | null;
		sessionId?: string | null;
		directory?: string | null;
		starting?: boolean;
		owned?: boolean;
		ready?: boolean;
		booting?: boolean;
		bootPending?: boolean;
		boot?: SandboxBoot | null;
		comments?: ChatComment[];
		remoteDrafts?: RemoteDraft[];
		authorOf?: (messageId: string) => ChatAuthor | null;
		beforePrompt?: (sessionId: string, text: string) => Promise<{ messageID?: string }>;
		onDraftChange?: (text: string) => void;
		onComment?: (text: string) => void | Promise<void>;
		onstart: () => void;
		onturndone?: () => void;
	} = $props();

	const canStart = $derived(sandbox.status === 'stopped' || sandbox.status === 'error');

	const store = $derived.by(() => {
		const id = sandbox.id;
		return untrack(
			() =>
				new ChatSessionStore(id, {
					initialSessionId: sessionId,
					onTurnDone: () => onturndone?.(),
					onDraftChange: (text) => onDraftChange?.(text),
					beforePrompt: (sid, text) => beforePrompt?.(sid, text) ?? Promise.resolve({})
				})
		);
	});

	$effect(() => {
		const current = store;
		return () => current.destroy();
	});

	$effect(() => {
		if (!ready) return;
		const current = store;
		untrack(() => {
			current.connect();
		});
		return () => current.pause();
	});

	$effect(() => {
		store.directory = directory ?? ocDirectory(selectedRepo);
	});

	$effect(() => {
		const me = $user;
		const name = me?.name || [me?.firstName, me?.lastName].filter(Boolean).join(' ');
		store.self = me ? { id: me.id, name: name || me.email, avatarUrl: me.imageUrl ?? null } : null;
	});

	$effect(() => {
		store.comments = comments;
		store.authorOf = authorOf ?? (() => null);
	});

	$effect(() => {
		const repo = store.activeSession?.repo;
		if (repo) selectedRepo = repo;
	});

	let synced: string | null = null;

	$effect(() => {
		const id = store.activeId;
		if (!id || store.activeSession?.pending || id === synced) return;
		synced = id;
		sessionId = id;
	});

	$effect(() => {
		const wanted = sessionId;
		if (!wanted || wanted === synced || store.connection !== 'ready' || !store.settled) return;
		synced = wanted;
		untrack(() => {
			store.selectSession(wanted);
		});
	});
</script>

<div class="chat-root">
	{#if !owned}
		<div class="chat-gate">
			<p class="chat-gate-text">This sandbox belongs to someone else.</p>
			<p class="chat-gate-sub">Chat, terminal, editor, and git are limited to the sandbox owner.</p>
		</div>
	{:else if bootPending}
		<div class="chat-gate chat-gate--skeleton" aria-hidden="true">
			<Skeleton height="0.75rem" width="45%" />
			<Skeleton height="0.75rem" width="82%" />
			<Skeleton height="0.75rem" width="68%" />
		</div>
	{:else if !ready}
		<div class="chat-gate">
			{#if booting}
				<SandboxBootProgress {boot} status={sandbox.status} />
			{:else}
				<p class="chat-gate-text">Start the sandbox to chat.</p>
				{#if canStart}
					<Button variant="primary" loading={starting} onclick={onstart}>
						<Play class="h-4 w-4" /> Start sandbox
					</Button>
				{:else}
					<p class="chat-gate-sub">Waiting for the sandbox to be ready.</p>
				{/if}
			{/if}
		</div>
	{:else}
		<ChatPanel {store} tabs {remoteDrafts} {onComment} />
	{/if}
</div>

<style>
	.chat-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.chat-gate {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2.5rem 1rem;
	}

	.chat-gate--skeleton {
		align-items: stretch;
		justify-content: flex-end;
		width: 100%;
		max-width: 47.5rem;
		margin: 0 auto;
	}

	.chat-gate-text {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}

	.chat-gate-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
</style>
