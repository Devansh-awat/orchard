<script lang="ts">
	import { LoaderCircle } from 'lucide-svelte';
	import { HumanMessage } from '$lib/components/sandbox/chat';
	import ErrorPart from '$lib/components/sandbox/chat/parts/ErrorPart.svelte';
	import type { PersonRef } from './types';

	let {
		prompt = null,
		author = null,
		time = null,
		phase,
		error = null,
		canEdit = false,
		busy = false,
		onretry,
		onremove
	}: {
		prompt?: string | null;
		author?: PersonRef | null;
		time?: number | null;
		phase: 'worktree' | 'agent';
		error?: string | null;
		canEdit?: boolean;
		busy?: boolean;
		onretry: () => void;
		onremove: () => void;
	} = $props();
</script>

<div class="prep" data-testid="session-preparing">
	<div class="prep-scroll">
		<div class="prep-col">
			{#if prompt}
				<HumanMessage text={prompt} {author} own {time} />
			{/if}
			<div class="prep-turn">
				{#if error}
					<ErrorPart detail={error} />
					{#if canEdit}
						<div class="prep-actions" data-align="content">
							<button
								type="button"
								class="gh-btn gh-btn--primary"
								disabled={busy}
								onclick={onretry}
							>
								Try again
							</button>
							<button type="button" class="gh-btn" disabled={busy} onclick={onremove}>
								Remove
							</button>
						</div>
					{/if}
				{:else}
					<span class="prep-mark" aria-hidden="true">
						<span class="spin" data-motion="progress"
							><LoaderCircle size={16} strokeWidth={1.75} /></span
						>
					</span>
					<p class="prep-line" data-align="content" role="status">
						{phase === 'worktree' ? 'Setting up the worktree…' : 'Starting the agent…'}
					</p>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.prep {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.prep-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		padding: var(--space-6) 0 var(--space-4);
		scrollbar-gutter: stable both-edges;
	}

	.prep-col {
		--chat-gutter: 2rem;
		--chat-inset: 1rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		margin: auto auto 0;
		padding: 0 calc(var(--chat-gutter) + var(--chat-inset));
	}

	@container chat-pane (min-width: 48rem) {
		.prep-col {
			--chat-inset: 1.5rem;
		}
	}

	.prep-turn {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.prep-mark {
		position: absolute;
		top: 0;
		left: calc(-1 * var(--chat-gutter));
		width: var(--chat-gutter);
		display: flex;
		justify-content: center;
		color: var(--text-muted);
	}

	.spin {
		display: inline-flex;
		margin-top: 0.125rem;
		animation: spin 1s linear infinite;
	}

	.prep-line {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.prep-actions {
		display: flex;
		gap: var(--space-2);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
