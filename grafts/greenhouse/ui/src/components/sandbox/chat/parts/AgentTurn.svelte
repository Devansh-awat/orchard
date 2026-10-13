<script lang="ts">
	import Pip from '../../../greenhouse/mascot/Pip.svelte';
	import { greenhousePrefs } from '../../../greenhouse/prefs.svelte';
	import type { ChatSessionStore } from '../session-store.svelte';
	import { stripSycophancy } from '../sycophancy';
	import { liveStep, type AgentBlock } from '../turns';
	import ActivityRow from './ActivityRow.svelte';
	import ErrorPart from './ErrorPart.svelte';
	import NoteLine from './NoteLine.svelte';
	import TextPart from './TextPart.svelte';
	import TurnFooter from './TurnFooter.svelte';
	import WorkingLine from './WorkingLine.svelte';

	let {
		block,
		store,
		live = false,
		latest = false,
		status = null
	}: {
		block: AgentBlock;
		store: ChatSessionStore;
		live?: boolean;
		latest?: boolean;
		status?: string | null;
	} = $props();

	const tidy = $derived(greenhousePrefs.values.notAbsolutelyRight);
	const activity = $derived(block.steps.length > 0);
	const lead = $derived(
		activity || (live && block.answer.length === 0)
			? 'row'
			: block.answer.length > 0
				? 'prose'
				: 'small'
	);
	const workingOnly = $derived(
		live &&
			!activity &&
			block.answer.length === 0 &&
			block.errors.length === 0 &&
			block.notes.length === 0
	);
	const result = $derived(block.result?.entry.kind === 'result' ? block.result.entry : null);
	const resultIndex = $derived(block.result?.index ?? 0);
	const empty = $derived(
		!!result &&
			!live &&
			!activity &&
			block.answer.length === 0 &&
			block.errors.length === 0 &&
			block.notes.length === 0
	);
</script>

<div
	class="turn"
	class:turn--latest={latest}
	data-turn="agent"
	data-live={live ? 'true' : undefined}
>
	{#if !workingOnly}
		<span class="turn-mark turn-mark--{lead}" aria-hidden="true">
			<span class="mark"><Pip size={18} playing={false} /></span>
		</span>
	{/if}
	{#if activity}
		<ActivityRow {block} {store} {live} />
	{/if}
	{#each block.notes as part (part.entry.key)}
		{#if part.entry.kind === 'note'}
			<NoteLine
				entry={part.entry}
				author={store.noteAuthor(part.entry)}
				selfId={store.self?.id ?? null}
			/>
		{/if}
	{/each}
	{#each block.answer as part (part.entry.key)}
		{#if part.entry.kind === 'text'}
			<TextPart text={tidy ? stripSycophancy(part.entry.text) : part.entry.text} align />
		{/if}
	{/each}
	{#each block.errors as part (part.entry.key)}
		{#if part.entry.kind === 'error'}
			<ErrorPart detail={part.entry.detail} auth={part.entry.auth ?? false} />
		{/if}
	{/each}
	{#if live}
		<WorkingLine start={block.start} label={status ?? liveStep(block)} />
	{/if}
	{#if empty}
		<p class="turn-empty" data-align="content">The agent returned no output</p>
	{/if}
	{#if result}
		<div class="turn-foot">
			<TurnFooter
				entry={result}
				showDuration={!activity}
				promptId={store.busy ? null : store.turnPromptId(resultIndex)}
				locked={store.revertBusy !== null}
				onfork={(id) => store.fork(id)}
				onrevert={(id) => store.revert(id)}
				oncopy={() => navigator.clipboard.writeText(store.turnText(resultIndex))}
			/>
		</div>
	{/if}
</div>

<style>
	.turn {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.turn-mark {
		position: absolute;
		left: calc(-1 * var(--chat-gutter));
		width: var(--chat-gutter);
		display: flex;
		justify-content: center;
		color: var(--text-muted);
	}

	.turn-mark--row {
		top: 0.375rem;
	}

	.turn-mark--prose {
		top: calc((var(--gh-lh-reading, 1.5rem) - 1.25rem) / 2);
	}

	.turn-mark--small {
		top: 0;
	}

	.mark {
		display: inline-grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--text-muted);
	}

	.turn-empty {
		margin: 0;
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		color: var(--text-muted);
	}

	.turn-foot {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.turn--latest .turn-foot {
		position: static;
	}

	.turn--latest .turn-foot,
	.turn:hover .turn-foot,
	.turn:focus-within .turn-foot {
		opacity: 1;
	}
</style>
