<script lang="ts">
	import { ListChecks } from 'lucide-svelte';
	import { Button } from '@orchardlabs/graft-ui';
	import { relativePath, type PlanHandoff, type QuestionRequest } from '../pending';
	import type { ChatSessionStore } from '../session-store.svelte';
	import RequestCard from './RequestCard.svelte';
	import TextPart from './TextPart.svelte';

	let {
		store,
		request,
		handoff,
		summary = null,
		directory = null,
		readonly = false,
		focusOnMount = false
	}: {
		store: ChatSessionStore;
		request: QuestionRequest;
		handoff: PlanHandoff;
		summary?: string | null;
		directory?: string | null;
		readonly?: boolean;
		focusOnMount?: boolean;
	} = $props();

	let feedback = $state('');
	let plan = $state<string | null>(null);

	const path = $derived(handoff.path ? relativePath(handoff.path, directory) : null);
	const steering = $derived(feedback.trim().length > 0);
	const body = $derived(plan?.trim() ? plan : summary);

	$effect(() => {
		const file = path;
		const dir = directory;
		plan = null;
		if (!file) return;
		let live = true;
		void store.readFile(file, dir).then((text) => {
			if (live) plan = text;
		});
		return () => {
			live = false;
		};
	});

	function build() {
		if (!readonly) void store.answerPlan(request.id, true);
	}

	function keep() {
		if (!readonly) void store.answerPlan(request.id, false, feedback);
	}

	function onkey(e: KeyboardEvent) {
		if (readonly || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		const target = e.target as HTMLElement;
		if (target instanceof HTMLInputElement) {
			if (e.key === 'Enter' && steering) {
				e.preventDefault();
				keep();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				(e.currentTarget as HTMLElement).focus({ preventScroll: true });
			}
			return;
		}
		if (e.key === 'Enter' && target === e.currentTarget) {
			e.preventDefault();
			build();
		}
	}
</script>

<RequestCard label="Plan ready" {readonly} {focusOnMount} {onkey}>
	{#snippet header()}
		<span class="plan-glyph" aria-hidden="true"><ListChecks size={16} strokeWidth={1.75} /></span>
		<span class="plan-title">Plan ready</span>
		{#if path}<span class="plan-path" title={handoff.path}>{path}</span>{/if}
	{/snippet}
	{#if body}
		<div class="plan-summary" data-align="inset">
			<TextPart text={body} compact />
		</div>
	{/if}
	{#snippet actions()}
		<Button size="sm" variant="primary" title="Start building (↵)" onclick={build}>
			Start building
		</Button>
		<Button size="sm" onclick={keep}>{steering ? 'Send feedback' : 'Keep planning'}</Button>
		<input
			class="plan-feedback"
			bind:value={feedback}
			placeholder="Or tell the agent what to change"
			aria-label="Tell the agent what to change"
		/>
	{/snippet}
</RequestCard>

<style>
	.plan-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.plan-title {
		flex-shrink: 0;
		font-weight: 600;
	}

	.plan-path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	.plan-summary {
		max-height: min(24rem, 40vh);
		overflow-y: auto;
		padding-right: var(--space-2);
	}

	.plan-feedback {
		flex: 1;
		min-width: 12rem;
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-sunken);
		font: inherit;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.plan-feedback::placeholder {
		color: var(--text-faint);
	}

	.plan-feedback:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
