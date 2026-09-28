<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';

	let {
		text,
		label,
		prompt = false,
		class: className = ''
	}: { text: string; label: string; prompt?: boolean; class?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 2000);
	}
</script>

<button
	type="button"
	onclick={copy}
	class="inline-flex max-w-full items-center gap-3 rounded-lg px-4 py-3 font-mono text-sm transition-colors {className}"
>
	{#if prompt}<span class="shrink-0 opacity-50 select-none" aria-hidden="true">$</span>{/if}
	<span class="truncate">{text}</span>
	{#if copied}
		<Check size={16} strokeWidth={2} class="shrink-0" aria-hidden="true" />
	{:else}
		<Copy size={16} strokeWidth={2} class="shrink-0" aria-hidden="true" />
	{/if}
	<span class="sr-only" aria-live="polite">{copied ? 'Copied' : label}</span>
</button>
