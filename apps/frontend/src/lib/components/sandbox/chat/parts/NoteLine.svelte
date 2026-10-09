<script lang="ts">
	import { Ban, Check, CornerDownRight } from 'lucide-svelte';
	import { Avatar } from '$lib/components/ui';
	import type { ChatAuthor, NoteEntry } from '../session-store.svelte';

	let {
		entry,
		author = null,
		selfId = null
	}: { entry: NoteEntry; author?: ChatAuthor | null; selfId?: string | null } = $props();

	const other = $derived(author && author.id !== selfId ? author : null);
	const Glyph = $derived(
		entry.tone === 'allowed' ? Check : entry.tone === 'denied' ? Ban : CornerDownRight
	);
</script>

<p class="note" data-align="content" title={other ? other.name : undefined}>
	{#if other}
		<span class="note-avatar" aria-hidden="true">
			<Avatar
				user={{ id: other.id, name: other.name, imageUrl: other.avatarUrl ?? null }}
				alt=""
				size={16}
				style="width: 1rem; height: 1rem; border-radius: 999px; object-fit: cover;"
			/>
		</span>
	{/if}
	<span class="note-glyph note-glyph--{entry.tone}" aria-hidden="true">
		<Glyph size={14} strokeWidth={1.75} />
	</span>
	<span class="note-text">
		{entry.lead}{#if entry.target}{' '}{#if entry.mono}<code class="note-code">{entry.target}</code
				>{:else}{entry.target}{/if}{/if}{#if entry.auto}{' '}automatically{/if}
	</span>
	{#if other}<span class="note-who">{other.name.split(' ')[0] || other.name}</span>{/if}
</p>

<style>
	.note {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		margin: 0;
		min-height: 1.75rem;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.note-avatar {
		position: absolute;
		left: calc(-1 * var(--chat-gutter, 2rem));
		top: 50%;
		display: flex;
		justify-content: center;
		width: var(--chat-gutter, 2rem);
		transform: translateY(-50%);
	}

	.note-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		justify-content: center;
		color: var(--text-faint);
	}

	.note-glyph--allowed {
		color: var(--status-success);
	}

	.note-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note-code {
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: 0.9em;
		color: var(--text-default);
	}

	.note-who {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}
</style>
