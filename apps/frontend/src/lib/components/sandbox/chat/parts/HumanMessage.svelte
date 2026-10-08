<script lang="ts">
	import { Bot, GitFork, MessageCircle, Undo2 } from 'lucide-svelte';
	import { Avatar } from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
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
	const showActions = $derived(!comment && actions && !!messageID && !!onfork && !!onrevert);
</script>

<div
	class="hm"
	class:hm--own={own}
	class:hm--other={!own}
	class:hm--grouped={grouped}
	class:hm--comment={comment}
	class:hm--reverted={reverted}
>
	{#if !own}
		<span class="hm-avatar" aria-hidden={grouped}>
			{#if !grouped && author}
				<Avatar
					user={{ id: author.id, name: author.name, imageUrl: author.avatarUrl ?? null }}
					alt={author.name}
					size={24}
					style="width: 1.5rem; height: 1.5rem; border-radius: 999px; object-fit: cover;"
				/>
			{/if}
		</span>
	{/if}
	<div class="hm-body">
		{#if !grouped && (!own || comment)}
			<div class="hm-meta">
				{#if !own && author}<span class="hm-name">{author.name}</span>{/if}
				{#if comment}
					<span class="hm-kind"><MessageCircle class="h-3 w-3" /> comment</span>
				{:else if !own}
					<span class="hm-kind"><Bot class="h-3 w-3" /> to agent</span>
				{/if}
				{#if comment && time !== null && Number.isFinite(time)}
					<span class="hm-time">{fmtClock(time)}</span>
				{/if}
			</div>
		{/if}
		<div class="hm-line">
			{#if showActions && messageID}
				{@const id = messageID}
				<div class="hm-actions">
					<button
						type="button"
						class="hm-action"
						disabled={locked}
						title="Fork a new session from here"
						onclick={() => onfork?.(id)}
					>
						<GitFork class="h-3 w-3" /> Fork
					</button>
					<button
						type="button"
						class="hm-action"
						disabled={locked}
						title="Undo everything from this prompt on"
						onclick={() => onrevert?.(id)}
					>
						<Undo2 class="h-3 w-3" /> Revert
					</button>
				</div>
			{/if}
			<div class="hm-bubble">
				{#if text}<div class="hm-text">{text}</div>{/if}
				{#if attachments.length > 0}
					<div class="hm-files"><FileParts files={attachments} /></div>
				{/if}
			</div>
		</div>
	</div>
</div>
{#if reverted}
	<div class="hm-reverted" transition:slide>
		<span>Reverted from here</span>
		<button type="button" class="hm-action" disabled={locked} onclick={() => onunrevert?.()}>
			Undo
		</button>
	</div>
{/if}

<style>
	.hm {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 1.25rem 0 0.75rem;
	}

	.hm--own {
		justify-content: flex-end;
	}

	.hm--grouped {
		margin-top: -0.875rem;
	}

	.hm-avatar {
		display: inline-flex;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		margin-top: 1.125rem;
	}

	.hm--grouped .hm-avatar {
		margin-top: 0;
		height: 0;
	}

	.hm-body {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		min-width: 0;
		max-width: min(38rem, 85%);
	}

	.hm--own .hm-body {
		align-items: flex-end;
	}

	.hm-meta {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		padding: 0 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	.hm-name {
		font-weight: 500;
		color: var(--text-muted);
	}

	.hm-kind {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		align-self: center;
		color: var(--text-faint);
	}

	.hm-time {
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.hm-line {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		max-width: 100%;
	}

	.hm--other .hm-line {
		flex-direction: row-reverse;
		justify-content: flex-end;
	}

	.hm-bubble {
		min-width: 0;
		padding: 0.5625rem 0.875rem;
		border-radius: var(--radius-xl);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
	}

	.hm--own .hm-bubble {
		border-bottom-right-radius: var(--radius-xs);
	}

	.hm--other .hm-bubble {
		border-bottom-left-radius: var(--radius-xs);
	}

	.hm--comment .hm-bubble {
		background: var(--fill-quiet);
		box-shadow: none;
		padding: 0.4375rem 0.75rem;
	}

	.hm-text {
		font-size: var(--text-body);
		line-height: 1.55;
		color: var(--text-default);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.hm--comment .hm-text {
		font-size: var(--text-callout);
		color: var(--text-muted);
	}

	.hm-text + .hm-files {
		margin-top: 0.5rem;
	}

	.hm--reverted .hm-bubble {
		opacity: 0.55;
	}

	.hm--reverted .hm-text {
		text-decoration: line-through;
	}

	.hm-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.hm:hover .hm-actions,
	.hm:focus-within .hm-actions {
		opacity: 1;
	}

	.hm-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
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
		justify-content: flex-end;
		gap: 0.5rem;
		margin: -0.25rem 0 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
</style>
