<script lang="ts">
	import { MessageSquareText } from 'lucide-svelte';
	import { greenhousePrefs } from '../../../greenhouse/prefs.svelte';
	import type { ChatEntry, ChatSessionStore } from '../session-store.svelte';
	import { stripSycophancy } from '../sycophancy';
	import Entry from './Entry.svelte';
	import ErrorPart from './ErrorPart.svelte';
	import ReasoningPart from './ReasoningPart.svelte';
	import SubagentPart from './SubagentPart.svelte';
	import TextPart from './TextPart.svelte';
	import ToolPart from './ToolPart.svelte';

	let {
		entry,
		store,
		depth = 0,
		live = false
	}: {
		entry: ChatEntry;
		store: ChatSessionStore;
		index?: number;
		depth?: number;
		live?: boolean;
	} = $props();

	const nested = $derived(depth > 0);
	const prefs = $derived(greenhousePrefs.values);
</script>

{#if entry.kind === 'user'}
	<p class="sub-prompt">{entry.text}</p>
{:else if entry.kind === 'thinking'}
	{#if prefs.showReasoning}
		<ReasoningPart {entry} {live} {nested} />
	{/if}
{:else if entry.kind === 'text'}
	<div class="note" data-align={nested ? undefined : 'step'}>
		<span class="note-glyph" aria-hidden="true">
			<MessageSquareText size={16} strokeWidth={1.75} />
		</span>
		<div class="note-text">
			<TextPart
				text={prefs.notAbsolutelyRight ? stripSycophancy(entry.text) : entry.text}
				compact
			/>
		</div>
	</div>
{:else if entry.kind === 'tool'}
	<ToolPart {entry} {nested} opener={store.fileOpener} />
{:else if entry.kind === 'agent'}
	<SubagentPart {entry} {nested} ontoggle={(agent) => store.toggleAgent(agent)}>
		{#each entry.entries as child, ci (child.key)}
			<Entry entry={child} {store} index={ci} depth={depth + 1} />
		{/each}
	</SubagentPart>
{:else if entry.kind === 'error'}
	<ErrorPart detail={entry.detail} auth={entry.auth ?? false} />
{/if}

<style>
	.sub-prompt {
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		font-weight: 600;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.note {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		min-width: 0;
		padding: 0.375rem 0;
	}

	.note-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		margin-top: 0.125rem;
		color: var(--text-faint);
	}

	.note-text {
		min-width: 0;
		color: var(--text-muted);
	}
</style>
