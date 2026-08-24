<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { ArrowLeft, ArrowUp, Lock, Pin, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts, isSuperAdmin, user } from '$lib/stores';
	import { Button, Dropdown, StatusBadge, Skeleton } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { timeAgo, projectSwatch } from '$lib/components/org-dashboard/helpers.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import {
		groveStatus,
		grovePriority,
		scopeLabel,
		GROVE_STATUSES,
		GROVE_PRIORITIES,
		type GroveThread,
		type GroveReply
	} from '$lib/components/grove/grove';
	import ImageAttach from '$lib/components/grove/ImageAttach.svelte';
	import { avatarUrl, avatarFilter } from '$lib/avatar';

	type FullThread = GroveThread & { body: string; replies: GroveReply[] };

	let thread = $state<FullThread | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let replyBody = $state('');
	let replyImages = $state<string[]>([]);
	let replying = $state(false);
	let adminStatus = $state('open');
	let adminPriority = $state('none');
	let adminBusy = $state(false);
	let confirmThreadDelete = $state(false);
	let replyToDelete = $state<GroveReply | null>(null);
	let confirmReplyDelete = $state(false);

	const threadId = $derived($page.params.id ?? '');
	const canModerate = $derived($isSuperAdmin);
	const canDeleteThread = $derived(!!thread && (canModerate || thread.author.id === $user?.id));

	function canDeleteReply(reply: GroveReply): boolean {
		return canModerate || reply.author.id === $user?.id;
	}

	async function deleteThread() {
		if (!thread) return;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}`, { method: 'DELETE' });
		if (res.ok) {
			goto('/grove');
		} else {
			const data = await res.json().catch(() => ({}));
			toasts.add({
				title: 'Error',
				description: data?.message || 'Failed to delete',
				color: 'error'
			});
		}
	}

	async function deleteReply() {
		if (!thread || !replyToDelete) return;
		const target = replyToDelete;
		replyToDelete = null;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/replies/${target.id}`, {
			method: 'DELETE'
		});
		if (res.ok) {
			thread.replies = thread.replies.filter((r) => r.id !== target.id);
			thread.replyCount = Math.max(0, thread.replyCount - 1);
		} else {
			const data = await res.json().catch(() => ({}));
			toasts.add({
				title: 'Error',
				description: data?.message || 'Failed to delete',
				color: 'error'
			});
		}
	}

	async function fetchThread() {
		loading = true;
		const res = await apiFetch(`/apiv1/forum/threads/${threadId}`);
		if (res.ok) {
			thread = await res.json();
			adminStatus = thread?.status ?? 'open';
			adminPriority = thread?.priority ?? 'none';
		} else {
			error = res.status === 404 ? 'This post does not exist' : 'Failed to load post';
		}
		loading = false;
	}

	async function refreshThread() {
		if (replying) return;
		const res = await apiFetch(`/apiv1/forum/threads/${threadId}`);
		if (!res.ok || !thread) return;
		const fresh: FullThread = await res.json();
		thread.replies = fresh.replies;
		thread.replyCount = fresh.replyCount;
		thread.status = fresh.status;
		thread.priority = fresh.priority;
		thread.pinned = fresh.pinned;
		thread.locked = fresh.locked;
		thread.votes = fresh.votes;
		thread.myVote = fresh.myVote;
	}

	async function toggleVote() {
		if (!thread) return;
		const on = !thread.myVote;
		thread.myVote = on;
		thread.votes += on ? 1 : -1;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/vote`, {
			method: on ? 'POST' : 'DELETE'
		});
		if (res.ok) {
			const data = await res.json();
			thread.votes = data.votes;
			thread.myVote = data.myVote;
		}
	}

	async function submitReply() {
		if (!thread || replying || replyBody.trim().length === 0) return;
		replying = true;
		try {
			const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/replies`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: replyBody, images: replyImages })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to reply');
			}
			const reply = await res.json();
			thread.replies.push(reply);
			thread.replyCount += 1;
			replyBody = '';
			replyImages = [];
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to reply',
				color: 'error'
			});
		} finally {
			replying = false;
		}
	}

	function onComposerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitReply();
		}
	}

	async function applyPriority() {
		if (!thread || adminBusy) return;
		adminBusy = true;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/priority`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ priority: adminPriority })
		});
		if (res.ok) thread.priority = adminPriority;
		adminBusy = false;
	}

	async function applyStatus() {
		if (!thread || adminBusy) return;
		adminBusy = true;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/status`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: adminStatus })
		});
		if (res.ok) thread.status = adminStatus;
		adminBusy = false;
	}

	async function togglePinned() {
		if (!thread || adminBusy) return;
		adminBusy = true;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/pinned`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinned: !thread.pinned })
		});
		if (res.ok) thread.pinned = !thread.pinned;
		adminBusy = false;
	}

	async function toggleLocked() {
		if (!thread || adminBusy) return;
		adminBusy = true;
		const res = await apiFetch(`/apiv1/forum/threads/${thread.id}/locked`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ locked: !thread.locked })
		});
		if (res.ok) thread.locked = !thread.locked;
		adminBusy = false;
	}

	onMount(() => {
		fetchThread();
		const poll = setInterval(refreshThread, 8000);
		return () => clearInterval(poll);
	});
</script>

<svelte:head><title>{thread ? `${thread.title} · The Grove` : 'The Grove'}</title></svelte:head>

<div class="gt-page">
	<div class="gt-shell">
		<a href="/grove" class="gt-back"><ArrowLeft class="h-3.5 w-3.5" /> The Grove</a>

		{#if loading}
			<Skeleton height="12rem" />
		{:else if error || !thread}
			<p class="gt-error">{error ?? 'Failed to load post'}</p>
		{:else}
			<article class="gt-thread" {@attach motionStagger({ index: 0, from: { y: 10 } })}>
				<div class="gt-meta">
					<span class="gt-num">#{thread.number}</span>
					<span class="gt-cat">{thread.category.name}</span>
					<span class="gt-cat">{scopeLabel(thread.scope)}</span>
					{#if grovePriority(thread.priority)}
						<StatusBadge meta={grovePriority(thread.priority)!} />
					{/if}
					<StatusBadge meta={groveStatus(thread.status)} />
					{#if thread.pinned}<span class="gt-flag"><Pin size={12} /> Pinned</span>{/if}
					{#if thread.locked}<span class="gt-flag"><Lock size={12} /> Locked</span>{/if}
				</div>
				<h1 class="gt-title">{thread.title}</h1>
				<div class="gt-author-row">
					<img
						src={avatarUrl(thread.author)}
						style="filter: {avatarFilter(thread.author)}"
						alt=""
						class="gt-av"
						loading="lazy"
						decoding="async"
					/>
					<span class="gt-author">{thread.author.username}</span>
					<span class="gt-when" title={thread.createdAt}>{timeAgo(thread.createdAt)}</span>
					<button
						type="button"
						class="gt-vote"
						class:gt-vote--on={thread.myVote}
						aria-pressed={thread.myVote}
						onclick={toggleVote}
					>
						<ArrowUp size={13} />
						{thread.votes}
					</button>
					{#if canDeleteThread}
						<button
							type="button"
							class="gt-delete"
							aria-label="Delete post"
							onclick={() => (confirmThreadDelete = true)}
						>
							<Trash2 size={13} />
						</button>
					{/if}
				</div>
				<div class="gt-body">{thread.body}</div>
				{#if thread.images.length > 0}
					<div class="gt-images">
						{#each thread.images as url (url)}
							<a href={url} target="_blank" rel="noopener noreferrer" class="gt-image-link">
								<img src={url} alt="" class="gt-image" loading="lazy" decoding="async" />
							</a>
						{/each}
					</div>
				{/if}

				{#if $isSuperAdmin}
					<div class="gt-admin">
						<Dropdown
							bind:value={adminStatus}
							class="gt-admin-dd"
							options={GROVE_STATUSES.map((s) => ({ value: s, label: groveStatus(s).label }))}
							onchange={applyStatus}
						/>
						<Dropdown
							bind:value={adminPriority}
							class="gt-admin-dd"
							options={[
								{ value: 'none', label: 'No priority' },
								...GROVE_PRIORITIES.filter((p) => p !== 'none').map((p) => ({
									value: p,
									label: grovePriority(p)?.label ?? p
								}))
							]}
							onchange={applyPriority}
						/>
						<Button variant="ghost" size="sm" disabled={adminBusy} onclick={togglePinned}>
							<Pin class="h-3.5 w-3.5" />
							{thread.pinned ? 'Unpin' : 'Pin'}
						</Button>
						<Button variant="ghost" size="sm" disabled={adminBusy} onclick={toggleLocked}>
							<Lock class="h-3.5 w-3.5" />
							{thread.locked ? 'Unlock' : 'Lock'}
						</Button>
					</div>
				{/if}
			</article>

			<section class="gt-replies">
				<h2 class="gt-replies-title">
					{thread.replies.length}
					{thread.replies.length === 1 ? 'reply' : 'replies'}
				</h2>
				{#each thread.replies as reply, i (reply.id)}
					<div class="gt-reply" {@attach motionStagger({ index: i, from: { y: 8 } })}>
						<img
							src={avatarUrl(reply.author)}
							style="filter: {avatarFilter(reply.author)}"
							alt=""
							class="gt-av"
							loading="lazy"
							decoding="async"
						/>
						<div class="gt-reply-main">
							<div class="gt-reply-head">
								<span class="gt-author">{reply.author.username}</span>
								<span class="gt-when" title={reply.createdAt}>{timeAgo(reply.createdAt)}</span>
								{#if canDeleteReply(reply)}
									<button
										type="button"
										class="gt-delete gt-delete--reply"
										aria-label="Delete reply"
										onclick={() => {
											replyToDelete = reply;
											confirmReplyDelete = true;
										}}
									>
										<Trash2 size={12} />
									</button>
								{/if}
							</div>
							<div class="gt-reply-body">{reply.body}</div>
							{#if reply.images.length > 0}
								<div class="gt-images">
									{#each reply.images as url (url)}
										<a href={url} target="_blank" rel="noopener noreferrer" class="gt-image-link">
											<img src={url} alt="" class="gt-image" loading="lazy" decoding="async" />
										</a>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/each}

				{#if thread.locked}
					<p class="gt-locked-note"><Lock size={12} /> This post is locked</p>
				{:else}
					<div class="gt-composer">
						<textarea
							class="gt-textarea"
							name="grove-reply-body"
							aria-label="Reply"
							bind:value={replyBody}
							rows="2"
							maxlength={10000}
							placeholder="Reply"
							onkeydown={onComposerKeydown}
						></textarea>
						<div class="gt-composer-actions">
							<ImageAttach bind:images={replyImages} disabled={replying} />
							<Button
								variant="primary"
								size="sm"
								disabled={replyBody.trim().length === 0}
								loading={replying}
								onclick={submitReply}
							>
								Reply
							</Button>
						</div>
					</div>
				{/if}
			</section>
		{/if}
	</div>
</div>

<ConfirmModal
	bind:open={confirmThreadDelete}
	title="Delete this post?"
	description="The post, its replies, and attached images are removed permanently."
	confirmLabel="Delete"
	onconfirm={deleteThread}
/>

<ConfirmModal
	bind:open={confirmReplyDelete}
	title="Delete this reply?"
	description="The reply and its attached images are removed permanently."
	confirmLabel="Delete"
	onconfirm={deleteReply}
	oncancel={() => (replyToDelete = null)}
/>

<style>
	.gt-page {
		min-height: 100vh;
		background: var(--bg-app);
	}

	.gt-shell {
		max-width: 46rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.gt-back {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		text-decoration: none;
		margin-bottom: 1.25rem;
	}

	.gt-back:hover {
		color: var(--text-default);
	}

	.gt-error {
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}

	.gt-thread {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		padding: 1.25rem;
	}

	.gt-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.gt-num {
		font-family: 'Space Mono', monospace;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.gt-cat {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: var(--radius-pill);
		padding: 0.125rem 0.5rem;
	}

	.gt-flag {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.gt-title {
		font-size: var(--text-title-3);
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1.3;
		color: var(--text-default);
	}

	.gt-author-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.75rem 0 0.875rem;
	}

	.gt-av {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: var(--radius-pill);
		flex-shrink: 0;
		object-fit: cover;
		display: inline-block;
	}

	.gt-author {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.gt-when {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.gt-vote {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		margin-left: auto;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease,
			border-color var(--dur-fast) ease;
	}

	.gt-vote:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.gt-vote--on {
		background: var(--accent-subtle);
		border-color: var(--accent);
		color: var(--accent);
	}

	.gt-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-xs);
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.gt-delete:hover {
		color: var(--status-error);
		background: var(--status-error-bg);
	}

	.gt-delete--reply {
		width: 1.5rem;
		height: 1.5rem;
		margin-left: auto;
	}

	.gt-body {
		font-size: var(--text-callout);
		line-height: 1.6;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.gt-images {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.75rem;
	}

	.gt-image-link {
		display: block;
		width: 8rem;
		height: 6rem;
	}

	.gt-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: var(--radius-sm);
		outline: 1px solid var(--border-default);
		outline-offset: -1px;
	}

	:global(.gt-admin-dd) {
		min-width: 8.5rem;
	}

	.gt-admin {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		padding-top: 0.875rem;
		border-top: 1px solid var(--border-default);
	}

	.gt-replies {
		margin-top: 1.5rem;
	}

	.gt-replies-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 0.75rem;
	}

	.gt-reply {
		display: flex;
		gap: 0.75rem;
		padding: 0.875rem 0;
		border-bottom: 1px solid var(--border-default);
	}

	.gt-reply-main {
		min-width: 0;
		flex: 1;
	}

	.gt-reply-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}

	.gt-reply-body {
		font-size: var(--text-callout);
		line-height: 1.55;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.gt-locked-note {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
		margin-top: 1rem;
	}

	.gt-composer {
		margin-top: 1rem;
	}

	.gt-textarea {
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-default);
		font-size: var(--text-callout);
		line-height: 1.5;
		padding: 0.75rem 0.75rem;
		resize: vertical;
	}

	.gt-textarea:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -1px;
	}

	.gt-composer-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
</style>
