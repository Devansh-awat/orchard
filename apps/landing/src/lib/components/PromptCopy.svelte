<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';
	import { installPrompt, installScript } from '$lib/links';

	const OPTIONS = [
		{ id: 'script', label: 'Script', text: installScript, done: 'Script copied' },
		{ id: 'prompt', label: 'Prompt', text: installPrompt, done: 'Prompt copied' }
	] as const;

	type Mode = (typeof OPTIONS)[number]['id'];

	let mode = $state<Mode>('script');
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

<div class="flex w-[380px] max-w-full flex-col gap-2">
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
		class="copy flex items-center gap-2.5 rounded-lg bg-crimson-deep px-3 py-2.5 text-left text-blush transition-colors hover:text-cream focus-visible:outline-3 focus-visible:outline-cream focus-visible:outline-offset-3"
	>
		<span
			class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]"
			title={mode === 'script' ? installScript : undefined}
		>
			{#each OPTIONS as option (option.id)}
				<span
					class="body {option.id === 'script'
						? 'font-mono text-[12px] leading-[1.55]'
						: 'text-[14px] leading-[1.45]'}"
					class:shown={mode === option.id}
					aria-hidden={mode !== option.id}
				>
					{#if option.id === 'script'}{#each option.text.split(' && ') as command, i (i)}<span
								class="line"
								><span class="text-rose select-none" aria-hidden="true">{'$ '}</span
								>{command}{#if i === 0}<span class="sr-only"> &&</span>{/if}</span
							>{/each}{:else}{option.text}{/if}
				</span>
			{/each}
		</span>
		<span class="shrink-0">
			{#if copied}
				<Check size={15} strokeWidth={2} aria-hidden="true" />
			{:else}
				<Copy size={15} strokeWidth={2} aria-hidden="true" />
			{/if}
		</span>
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

	.body {
		grid-area: 1 / 1;
		min-width: 0;
		align-self: center;
		overflow-wrap: anywhere;
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 0.18s ease,
			visibility 0s 0.18s;
	}

	.line {
		display: block;
		overflow: hidden;
		white-space: nowrap;
		overflow-wrap: normal;
		mask-image: linear-gradient(to right, #000 calc(100% - 2.5rem), transparent);
	}

	.body.shown {
		opacity: 1;
		visibility: visible;
		transition: opacity 0.18s ease;
	}
</style>
