<script lang="ts">
	import type { ChatEntry, ChatSessionStore } from '../session-store.svelte';
	import Entry from './Entry.svelte';
	import ErrorPart from './ErrorPart.svelte';
	import ReasoningPart from './ReasoningPart.svelte';
	import SubagentPart from './SubagentPart.svelte';
	import TextPart from './TextPart.svelte';
	import ToolPart from './ToolPart.svelte';
	import TurnFooter from './TurnFooter.svelte';

	let {
		entry,
		store,
		index = 0,
		depth = 0,
		live = false
	}: {
		entry: ChatEntry;
		store: ChatSessionStore;
		index?: number;
		depth?: number;
		live?: boolean;
	} = $props();
</script>

{#if entry.kind === 'user'}
	<p class="sub-prompt">{entry.text}</p>
{:else if entry.kind === 'thinking'}
	<ReasoningPart {entry} {live} />
{:else if entry.kind === 'text'}
	<TextPart text={entry.text} compact={depth > 0} />
{:else if entry.kind === 'tool'}
	<ToolPart {entry} />
{:else if entry.kind === 'agent'}
	<SubagentPart {entry} nested={depth > 0} ontoggle={(agent) => store.toggleAgent(agent)}>
		{#each entry.entries as child, ci (child.key)}
			<Entry entry={child} {store} index={ci} depth={depth + 1} />
		{/each}
	</SubagentPart>
{:else if entry.kind === 'result'}
	{#if depth === 0}
		<TurnFooter
			{entry}
			promptId={store.busy ? null : store.turnPromptId(index)}
			locked={store.revertBusy !== null}
			onfork={(id) => store.fork(id)}
			onrevert={(id) => store.revert(id)}
			oncopy={() => navigator.clipboard.writeText(store.turnText(index))}
		/>
	{/if}
{:else}
	<ErrorPart detail={entry.detail} />
{/if}

<style>
	.sub-prompt {
		font-size: var(--text-footnote);
		line-height: 1.5;
		font-weight: 600;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
