<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Check, Copy } from 'lucide-svelte';
	import { installPrompt, installScript } from '$lib/links';

	const OPTIONS = [
		{ id: 'prompt', label: 'Prompt', text: installPrompt, done: 'Prompt copied' },
		{ id: 'script', label: 'Script', text: installScript, done: 'Script copied' }
	] as const;

	type Mode = (typeof OPTIONS)[number]['id'];

	let mode = $state<Mode>('prompt');
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const current = $derived(OPTIONS.find((option) => option.id === mode) ?? OPTIONS[0]);

	function pick(next: Mode) {
		mode = next;
		copied = false;
		clearTimeout(timer);
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(current.text);
		} catch {
			return;
		}
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="flex w-[289px] max-w-full flex-col gap-2">
	<p class="flex items-center gap-2 text-base" role="group" aria-label="Install with">
		{#each OPTIONS as option, i (option.id)}
			{#if i > 0}<span class="text-rose/70" aria-hidden="true">/</span>{/if}
			<button
				type="button"
				class="tab"
				aria-pressed={mode === option.id}
				onclick={() => pick(option.id)}>{option.label}</button
			>
		{/each}
	</p>
	<button
		type="button"
		onclick={copy}
		title={current.text}
		class="flex h-9 items-center justify-center gap-[10px] overflow-hidden rounded-lg bg-crimson-deep px-2 text-base leading-5 text-blush transition-colors hover:text-cream focus-visible:outline-3 focus-visible:outline-cream focus-visible:outline-offset-3"
	>
		{#key mode}
			<span
				class="min-w-0 flex-1 truncate text-left {mode === 'script' ? 'font-mono text-[13px]' : ''}"
				in:fade={{ duration: 180 }}>{current.text}</span
			>
		{/key}
		{#if copied}
			<Check size={16} strokeWidth={2} class="shrink-0" aria-hidden="true" />
		{:else}
			<Copy size={16} strokeWidth={2} class="shrink-0" aria-hidden="true" />
		{/if}
		<span class="sr-only" aria-live="polite">{copied ? current.done : `Copy the ${mode}`}</span>
	</button>
</div>

<style>
	.tab {
		color: var(--color-rose);
		text-decoration: underline;
		text-decoration-color: transparent;
		text-underline-offset: 4px;
		transition:
			color 0.2s ease,
			text-decoration-color 0.2s ease;
	}

	.tab:hover {
		color: var(--color-cream);
	}

	.tab[aria-pressed='true'] {
		color: var(--color-cream);
		text-decoration-color: rgb(255 255 248 / 0.5);
	}

	.tab:focus-visible {
		outline: 2px solid var(--color-cream);
		outline-offset: 3px;
		border-radius: 3px;
	}
</style>
