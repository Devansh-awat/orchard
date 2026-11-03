<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';

	type Line = { kind: 'cmd' | 'ok' | 'dim' | 'out'; text: string };

	let {
		cwd = '~',
		lines,
		label,
		copy,
		caret = true
	}: {
		cwd?: string;
		lines: readonly Line[];
		label?: string;
		copy?: string;
		caret?: boolean;
	} = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copyCommand() {
		if (!copy) return;
		try {
			await navigator.clipboard.writeText(copy);
		} catch {
			return;
		}
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 2000);
	}
</script>

<div
	class="overflow-hidden rounded-2xl border-4 border-crimson bg-night-900 shadow-[0_40px_80px_-40px_rgb(120_0_20/0.55)]"
	role={copy ? undefined : 'img'}
	aria-label={copy ? undefined : (label ?? lines.map((l) => l.text).join('. '))}
>
	<div
		class="flex items-center justify-between border-b border-night-700 px-4 py-3 font-mono text-[12px] text-night-300"
	>
		<span>{cwd}</span>
		{#if copy}
			<button
				type="button"
				onclick={copyCommand}
				class="-my-1 -mr-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:text-night-100 focus-visible:outline-2 focus-visible:outline-rose"
			>
				{#if copied}
					<Check size={14} strokeWidth={2} aria-hidden="true" /> Copied
				{:else}
					<Copy size={14} strokeWidth={2} aria-hidden="true" /> Copy
				{/if}
				<span class="sr-only" aria-live="polite">{copied ? 'Command copied' : 'the command'}</span>
			</button>
		{:else}
			<span>zsh</span>
		{/if}
	</div>
	<div class="p-6 font-mono text-[clamp(12px,1.1vw,14px)] leading-[1.85] text-night-100">
		{#each lines as line, i (i)}
			<p class="wrap-anywhere">
				{#if line.kind === 'cmd'}
					<span class="text-rose">$</span> <span>{line.text}</span>
				{:else if line.kind === 'ok'}
					<span class="text-live">✓</span> <span>{line.text}</span>
				{:else if line.kind === 'out'}
					<span class="block pl-4 whitespace-pre-wrap">{line.text}</span>
				{:else}
					<span class="block pl-4 whitespace-pre-wrap text-night-300">{line.text}</span>
				{/if}
			</p>
		{/each}
		{#if caret}
			<p><span class="text-rose">$</span> <span class="caret text-night-300"></span></p>
		{/if}
	</div>
</div>
