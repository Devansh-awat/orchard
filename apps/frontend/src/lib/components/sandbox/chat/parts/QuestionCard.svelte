<script lang="ts">
	import { Check, MessageCircleQuestion } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { answered, collectAnswers, type QuestionRequest } from '../pending';
	import type { ChatSessionStore } from '../session-store.svelte';
	import RequestCard from './RequestCard.svelte';

	let {
		store,
		request,
		readonly = false,
		focusOnMount = false
	}: {
		store: ChatSessionStore;
		request: QuestionRequest;
		readonly?: boolean;
		focusOnMount?: boolean;
	} = $props();

	let step = $state(0);
	let picks = $state<string[][]>([]);
	let typed = $state<string[]>([]);
	let otherEl = $state<HTMLInputElement | undefined>(undefined);

	const count = $derived(request.questions.length);
	const at = $derived(Math.min(step, count - 1));
	const info = $derived(request.questions[at]);
	const chosen = $derived(picks[at] ?? []);
	const done = $derived(answered(request.questions, picks, typed));
	const last = $derived(at >= count - 1);
	const ready = $derived(last ? done.every(Boolean) : done[at]);
	const otherIndex = $derived(info.custom ? info.options.length : -1);

	function pick(index: number) {
		if (readonly) return;
		const option = info.options[index];
		if (!option) {
			if (index === otherIndex) otherEl?.focus();
			return;
		}
		const current = picks[at] ?? [];
		if (info.multiple) {
			picks[at] = current.includes(option.label)
				? current.filter((label) => label !== option.label)
				: [...current, option.label];
		} else {
			picks[at] = [option.label];
			typed[at] = '';
		}
	}

	function onTyped(e: Event) {
		const value = (e.currentTarget as HTMLInputElement).value;
		typed[at] = value;
		if (!info.multiple && value.trim()) picks[at] = [];
	}

	function advance() {
		if (readonly || !ready) return;
		if (!last) {
			step = at + 1;
			return;
		}
		void store.answerQuestion(request.id, collectAnswers(request.questions, picks, typed));
	}

	function onkey(e: KeyboardEvent) {
		if (readonly || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target as HTMLElement;
		const inField = target instanceof HTMLInputElement;
		if (e.key === 'Enter' && !e.shiftKey && (inField || target === e.currentTarget)) {
			e.preventDefault();
			advance();
			return;
		}
		if (inField) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				(e.currentTarget as HTMLElement).focus({ preventScroll: true });
			}
			return;
		}
		if (/^[1-9]$/.test(e.key)) {
			const index = Number(e.key) - 1;
			if (index < info.options.length || index === otherIndex) {
				e.preventDefault();
				pick(index);
			}
		}
	}
</script>

<RequestCard label={info.header || 'Question'} {readonly} {focusOnMount} {onkey}>
	{#snippet header()}
		<span class="q-glyph" aria-hidden="true">
			<MessageCircleQuestion size={16} strokeWidth={1.75} />
		</span>
		{#if info.header}<span class="q-chip">{info.header}</span>{/if}
		{#if count > 1}<span class="q-step">{at + 1} of {count}</span>{/if}
	{/snippet}
	<p class="q-text" data-align="inset">{info.question}</p>
	<div
		class="q-options"
		role={info.multiple ? 'group' : 'radiogroup'}
		aria-label={info.question}
		data-align="inset"
	>
		{#each info.options as option, oi (option.label)}
			{@const on = chosen.includes(option.label)}
			<button
				type="button"
				class="q-option"
				class:q-option--on={on}
				role={info.multiple ? 'checkbox' : 'radio'}
				aria-checked={on}
				disabled={readonly}
				onclick={() => pick(oi)}
			>
				<span
					class="q-mark"
					class:q-mark--box={info.multiple}
					class:q-mark--on={on}
					aria-hidden="true"
				>
					{#if on && info.multiple}<Check size={12} strokeWidth={2.5} />{:else if on}<span
							class="q-dot"
						></span>{/if}
				</span>
				<span class="q-body">
					<span class="q-label">{option.label}</span>
					{#if option.description}<span class="q-desc">{option.description}</span>{/if}
				</span>
				{#if oi < 9 && !readonly}<kbd class="q-key" aria-hidden="true">{oi + 1}</kbd>{/if}
			</button>
		{/each}
		{#if info.custom && !readonly}
			{@const on = (typed[at] ?? '').trim().length > 0}
			<label class="q-option q-option--other" class:q-option--on={on}>
				<span
					class="q-mark"
					class:q-mark--box={info.multiple}
					class:q-mark--on={on}
					aria-hidden="true"
				>
					{#if on && info.multiple}<Check size={12} strokeWidth={2.5} />{:else if on}<span
							class="q-dot"
						></span>{/if}
				</span>
				<input
					bind:this={otherEl}
					class="q-other"
					value={typed[at] ?? ''}
					placeholder="Something else…"
					aria-label="Another answer"
					oninput={onTyped}
				/>
				{#if otherIndex < 9}<kbd class="q-key" aria-hidden="true">{otherIndex + 1}</kbd>{/if}
			</label>
		{/if}
	</div>
	{#snippet actions()}
		{#if at > 0}
			<Button size="sm" variant="ghost" onclick={() => (step = at - 1)}>Back</Button>
		{/if}
		<span class="q-spacer"></span>
		<Button
			size="sm"
			variant="ghost"
			title="Dismiss the question, the agent stops"
			onclick={() => store.rejectQuestion(request.id)}
		>
			Skip
		</Button>
		<Button
			size="sm"
			variant="primary"
			disabled={!ready}
			title={last ? 'Submit (↵)' : 'Next (↵)'}
			onclick={advance}
		>
			{last ? 'Submit' : 'Next'}
		</Button>
	{/snippet}
</RequestCard>

<style>
	.q-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.q-chip {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 var(--space-2);
		border-radius: var(--radius-xs);
		background: var(--fill-soft);
		font-size: var(--text-caption);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.q-step {
		margin-left: auto;
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.q-text {
		margin: 0;
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		font-weight: 600;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.q-options {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
	}

	.q-option {
		display: grid;
		grid-template-columns: 1rem minmax(0, 1fr) auto;
		align-items: center;
		column-gap: var(--space-3);
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.q-option + .q-option {
		border-top: 1px solid var(--border-default);
	}

	.q-option:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.q-option--on,
	.q-option--on:hover:not(:disabled) {
		background: color-mix(in oklab, var(--accent) 9%, transparent);
	}

	.q-option:disabled {
		cursor: default;
	}

	.q-option:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.q-option--other {
		cursor: text;
	}

	.q-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.q-label {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.q-desc {
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.q-key {
		display: inline-grid;
		place-items: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.25rem;
		border-radius: var(--radius-xs);
		box-shadow: inset 0 0 0 1px var(--border-default);
		font-family: inherit;
		font-size: var(--text-caption);
		line-height: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}

	.q-option--on .q-key {
		color: var(--accent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent);
	}

	.q-mark {
		display: inline-grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-pill);
		box-shadow: inset 0 0 0 1.5px var(--border-strong);
		color: var(--text-on-accent);
		transition:
			background-color var(--dur-fast),
			box-shadow var(--dur-fast);
	}

	.q-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--text-on-accent);
	}

	.q-mark--box {
		border-radius: 0.25rem;
	}

	.q-mark--on {
		background: var(--accent);
		box-shadow: none;
	}

	.q-other {
		min-width: 0;
		height: 1.75rem;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.q-other::placeholder {
		color: var(--text-faint);
	}

	.q-other:focus-visible {
		outline: none;
	}

	.q-spacer {
		flex: 1;
	}
</style>
