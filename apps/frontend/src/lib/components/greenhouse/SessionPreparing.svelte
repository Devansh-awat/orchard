<script lang="ts">
	import { HumanMessage } from '$lib/components/sandbox/chat';
	import PixelSprout from '$lib/components/sandbox/chat/parts/PixelSprout.svelte';
	import { fmtElapsed } from '$lib/components/sandbox/chat/steps';
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

	const startedAt = time ?? Date.now();
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const step = $derived(phase === 'worktree' ? 1 : 2);
	const title = $derived(phase === 'worktree' ? 'Setting up your session' : 'Waking up the agent');
	const detail = $derived(
		phase === 'worktree'
			? 'Creating its own branch and folder'
			: prompt
				? 'Handing it your prompt'
				: 'Almost ready'
	);
	const meta = $derived(`Step ${step} of 2 · ${fmtElapsed(now - startedAt)}`);
</script>

<div class="prep" data-testid="session-preparing">
	{#if error}
		<div class="prep-scroll">
			<div class="prep-col">
				{#if prompt}
					<HumanMessage text={prompt} {author} own {time} />
				{/if}
				<div class="prep-turn">
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
				</div>
			</div>
		</div>
	{:else}
		<div class="prep-center" role="status" aria-live="polite">
			<span class="prep-plant" aria-hidden="true"><PixelSprout /></span>
			<p class="prep-title">{title}</p>
			<p class="prep-detail">{detail}</p>
			<div
				class="meter"
				role="progressbar"
				aria-label="Session setup"
				aria-valuemin={0}
				aria-valuemax={2}
				aria-valuenow={step - 1}
			>
				<span class="meter-fill" style="width: {((step - 0.5) / 2) * 100}%"></span>
			</div>
			<p class="meta" aria-hidden="true">{meta}</p>
			{#if prompt}
				<p class="prep-prompt">{prompt}</p>
			{/if}
		</div>
	{/if}
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

	.prep-center {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: var(--space-6);
		text-align: center;
	}

	.prep-plant {
		display: inline-grid;
		place-items: center;
		margin-bottom: 1rem;
		transform: scale(2.5);
		transform-origin: center bottom;
		height: 3rem;
	}

	.prep-title {
		margin: 0;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
		color: var(--gh-text);
	}

	.prep-detail,
	.meta {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.meter {
		width: 12rem;
		height: 0.25rem;
		margin-top: 0.75rem;
		border-radius: 999px;
		background: var(--fill-soft);
		overflow: hidden;
	}

	.meter-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--text-muted);
	}

	.prep-prompt {
		max-width: 28rem;
		margin: 1.5rem 0 0;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.prep-actions {
		display: flex;
		gap: var(--space-2);
	}
</style>
