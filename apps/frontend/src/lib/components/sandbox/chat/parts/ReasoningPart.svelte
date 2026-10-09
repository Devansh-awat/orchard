<script lang="ts">
	import { Brain } from 'lucide-svelte';
	import type { ThinkingEntry } from '../session-store.svelte';
	import { plainLine } from '../steps';
	import StepRow from './StepRow.svelte';

	let {
		entry,
		live = false,
		nested = false
	}: { entry: ThinkingEntry; live?: boolean; nested?: boolean } = $props();

	const open = $derived(entry.expanded);
	const preview = $derived.by(() => {
		if (open) return null;
		if (!live) return plainLine(entry.text, 90) || null;
		const lines = entry.text.split('\n').filter((l) => l.trim());
		return plainLine(lines[lines.length - 1] ?? '', 90) || null;
	});
</script>

<StepRow
	title={live ? 'Thinking' : 'Thought'}
	hint={open ? undefined : entry.text}
	{nested}
	expanded={open}
	ontoggle={() => (entry.expanded = !open)}
>
	{#snippet icon()}<Brain size={16} strokeWidth={1.75} />{/snippet}
	{#snippet trailing()}
		{#if preview}<span class="think-preview">{preview}</span>{/if}
	{/snippet}
	<p
		class="think-body"
		{@attach (el) => {
			void entry.text;
			if (live) el.scrollTop = el.scrollHeight;
		}}
	>
		{entry.text}
	</p>
</StepRow>

<style>
	.think-preview {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.think-body {
		margin: 0;
		max-height: 15rem;
		overflow-y: auto;
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
