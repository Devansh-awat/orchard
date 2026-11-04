<script lang="ts">
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import Snippet from '$lib/components/ui/Snippet.svelte';
	import type { SettingChange } from './setting-changes';

	let { change }: { change: SettingChange } = $props();
</script>

<div class="change">
	<span class="how">{change.how}</span>
	{#if change.command}
		<Snippet command={change.command} wrap />
	{:else if change.values}
		<CodeBlock code={change.values} language={change.language} wrap />
	{/if}
	<span class="effect">{change.effect}</span>
	{#if change.note}
		<span class="note">{change.note}</span>
	{/if}
</div>

<style>
	.change {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		text-align: left;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--change-ink, var(--text-muted));
	}

	.how {
		color: var(--change-ink-strong, var(--text-fg));
	}
</style>
