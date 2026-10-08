<script lang="ts">
	import { untrack } from 'svelte';
	import { X } from 'lucide-svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import type { DiffComment } from './comments.svelte';
	import { safeColorVar } from './styles';
	import type { DiffThreadProps } from './types';

	let {
		comments,
		remote,
		drafting,
		draftBody,
		author,
		onsubmit,
		oncancel,
		onreply,
		onremove,
		ondraftinput
	}: DiffThreadProps = $props();

	const AVATAR_STYLE = 'width: 1.25rem; height: 1.25rem; flex: none; border-radius: 999px;';

	let field = $state<HTMLTextAreaElement | null>(null);
	let body = $state(untrack(() => draftBody));

	$effect(() => {
		if (drafting && field) field.focus({ preventScroll: true });
	});

	function submit() {
		const text = body.trim();
		if (!text) return;
		onsubmit(text);
		body = '';
	}

	function cancel() {
		body = '';
		oncancel();
	}

	function onkeydown(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
	}

	function oninput() {
		ondraftinput(body);
	}

	function canRemove(comment: DiffComment) {
		return !comment.author || !author || comment.author.id === author.id;
	}
</script>

<div class="thread" role="group" aria-label="Review comments">
	{#each comments as comment (comment.id)}
		<div class="thread-item">
			<Avatar seed={comment.author?.id ?? 'you'} size={20} style={AVATAR_STYLE} />
			<div class="thread-main">
				<div class="thread-meta">
					<span class="thread-name">{comment.author?.name ?? 'You'}</span>
					<span class="thread-time">{formatRelativeTime(new Date(comment.createdAt))}</span>
				</div>
				<p class="thread-body">{comment.body}</p>
			</div>
			{#if canRemove(comment)}
				<button
					type="button"
					class="thread-remove"
					aria-label="Delete comment"
					onclick={() => onremove(comment.id)}
				>
					<X size={13} />
				</button>
			{/if}
		</div>
	{/each}

	{#each remote as draft (draft.userId)}
		<div class="thread-item thread-item--ghost" style="--who: var({safeColorVar(draft.colorVar)})">
			<Avatar seed={draft.userId} size={20} style={AVATAR_STYLE} />
			<div class="thread-main">
				<div class="thread-meta">
					<span class="thread-name">{draft.name}</span>
					<span class="thread-typing">is writing…</span>
				</div>
				{#if draft.body.trim()}
					<p class="thread-body thread-body--ghost">{draft.body}</p>
				{/if}
			</div>
		</div>
	{/each}

	{#if drafting}
		<div class="thread-composer">
			<textarea
				bind:this={field}
				bind:value={body}
				{oninput}
				{onkeydown}
				rows="2"
				placeholder={comments.length ? 'Reply' : 'Tell the agent what to change here'}
				aria-label="Comment"></textarea>
			<div class="thread-actions">
				<span class="thread-hint">⌘↵ to comment</span>
				<Button variant="ghost" size="sm" onclick={cancel}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={!body.trim()} onclick={submit}>
					Comment
				</Button>
			</div>
		</div>
	{:else if comments.length}
		<div class="thread-footer">
			<Button variant="ghost" size="sm" onclick={onreply}>Reply</Button>
		</div>
	{/if}
</div>

<style>
	.thread {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		max-width: 40rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		box-shadow: var(--elev-2);
		font-family: var(--font-sans);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-default);
		white-space: normal;
		cursor: auto;
	}

	.thread-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.thread-main {
		flex: 1;
		min-width: 0;
	}

	.thread-meta {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
	}

	.thread-name {
		font-weight: 600;
	}

	.thread-time,
	.thread-typing,
	.thread-hint {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}

	.thread-item--ghost .thread-name {
		color: var(--who);
	}

	.thread-body {
		margin-top: 0.125rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.thread-body--ghost {
		color: var(--text-muted);
	}

	.thread-remove {
		flex: none;
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		opacity: 0;
		transition:
			opacity var(--dur-fast) ease,
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.thread-item:hover .thread-remove,
	.thread-remove:focus-visible {
		opacity: 1;
	}

	.thread-remove:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.thread-composer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.thread-composer textarea {
		width: 100%;
		min-height: 3.5rem;
		resize: vertical;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		color: var(--text-default);
		font: inherit;
		outline: none;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.thread-composer textarea::placeholder {
		color: var(--text-faint);
	}

	.thread-composer textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.thread-actions,
	.thread-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.375rem;
	}

	.thread-actions .thread-hint {
		margin-right: auto;
	}

	.thread-footer {
		justify-content: flex-start;
		margin: -0.25rem 0 -0.25rem -0.25rem;
	}
</style>
