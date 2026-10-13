<script lang="ts">
	import { Bot, MessageCircle } from 'lucide-svelte';
	import { Avatar } from '@orchard/graft-ui';
	import { slide } from '../../../../lib/utils/transitions';
	import type { OcAttachment } from '../../opencode';
	import type { ChatAuthor } from '../session-store.svelte';
	import { fmtClock } from '../format';
	import FileParts from './FileParts.svelte';

	let {
		variant = 'prompt',
		text,
		attachments = [],
		author = null,
		own = true,
		grouped = false,
		time = null,
		messageID = null,
		reverted = false,
		actions = false,
		locked = false,
		onfork = undefined,
		onrevert = undefined,
		onunrevert = undefined
	}: {
		variant?: 'prompt' | 'comment';
		text: string;
		attachments?: OcAttachment[];
		author?: ChatAuthor | null;
		own?: boolean;
		grouped?: boolean;
		time?: number | null;
		messageID?: string | null;
		reverted?: boolean;
		actions?: boolean;
		locked?: boolean;
		onfork?: (messageID: string) => void;
		onrevert?: (messageID: string) => void;
		onunrevert?: () => void;
	} = $props();

	const comment = $derived(variant === 'comment');
	const clock = $derived(time !== null && Number.isFinite(time) ? fmtClock(time) : null);
	const showMeta = $derived(!grouped && (!own || comment));
	const align = $derived(own && comment ? 'own' : 'content');
</script>

<div
	class="hm"
	class:hm--own={own}
	class:hm--other={!own}
	class:hm--comment={comment}
	class:hm--prompt={!comment}
	class:hm--reverted={reverted}
	data-human={comment ? 'comment' : 'prompt'}
>
	{#if showMeta}
		<div class="hm-meta" data-align={align}>
			{#if !own && author}<span class="hm-name">{author.name}</span>{/if}
			{#if clock}<span class="hm-time">{clock}</span>{/if}
			<span class="hm-kind">
				{#if comment}
					<MessageCircle size={12} strokeWidth={2} />
					comment
				{:else}
					<Bot size={12} strokeWidth={2} />
					to agent
				{/if}
			</span>
		</div>
	{/if}
	<div class="hm-line">
		{#if !own && !grouped && author}
			<span class="hm-avatar" aria-hidden="true">
				<Avatar
					user={{ id: author.id, name: author.name, imageUrl: author.avatarUrl ?? null }}
					alt=""
					size={24}
					style="width: 1.5rem; height: 1.5rem; border-radius: 999px; object-fit: cover;"
				/>
			</span>
		{/if}
		<div class="hm-bubble" data-align={align}>
			{#if text}<p class="hm-text">{text}</p>{/if}
			{#if attachments.length > 0}
				<div class="hm-files"><FileParts files={attachments} /></div>
			{/if}
		</div>
	</div>
	{#if reverted}
		<div class="hm-reverted" transition:slide data-align={align}>
			<span>Reverted from here</span>
			<button type="button" class="hm-action" disabled={locked} onclick={() => onunrevert?.()}>
				Undo
			</button>
		</div>
	{/if}
</div>

<style>
	.hm {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.hm--own {
		align-items: flex-end;
	}

	.hm--other {
		align-items: flex-start;
	}

	.hm-meta {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		max-width: 100%;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.hm-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		color: var(--text-default);
	}

	.hm-time {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.hm-kind {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.hm-line {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-width: 0;
	}

	.hm--own.hm--comment .hm-line {
		flex-direction: row-reverse;
	}

	.hm-avatar {
		position: absolute;
		top: calc(var(--space-2) + (var(--gh-lh-reading, 1.5rem) - 1.5rem) / 2);
		left: calc(-1 * var(--chat-gutter));
		display: flex;
		justify-content: center;
		width: var(--chat-gutter);
	}

	.hm--prompt {
		align-items: stretch;
	}

	.hm-bubble {
		min-width: 0;
		max-width: min(36rem, 85%);
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: linear-gradient(var(--fill-soft), var(--fill-soft)) var(--bg-raised);
		box-shadow: var(--elev-1);
	}

	.hm--own .hm-bubble {
		border-color: transparent;
		background: var(--fill-soft);
		box-shadow: none;
	}

	.hm--comment .hm-bubble,
	.hm--own.hm--comment .hm-bubble {
		border-color: var(--border-default);
		background: none;
		box-shadow: none;
	}

	.hm--prompt .hm-bubble {
		flex: 1;
		max-width: none;
	}

	.hm-text {
		margin: 0;
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.hm-text + .hm-files {
		margin-top: var(--space-2);
	}

	.hm--reverted .hm-bubble {
		opacity: 0.55;
	}

	.hm--reverted .hm-text {
		text-decoration: line-through;
	}

	.hm-action {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.hm-action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.hm-action:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.hm-reverted {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}
</style>
