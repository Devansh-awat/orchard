<script lang="ts">
	type Line = { kind: 'cmd' | 'ok' | 'dim'; text: string };

	let {
		cwd = '~',
		lines,
		label
	}: { cwd?: string; lines: readonly Line[]; label?: string } = $props();
</script>

<div
	class="overflow-hidden rounded-2xl border-4 border-crimson bg-night-900 shadow-[0_40px_80px_-40px_rgb(120_0_20/0.55)]"
	role="img"
	aria-label={label ?? lines.map((l) => l.text).join('. ')}
>
	<div
		class="flex items-center justify-between border-b border-night-700 px-4 py-3 font-mono text-[12px] text-night-300"
	>
		<span>{cwd}</span>
		<span>zsh</span>
	</div>
	<div class="p-6 font-mono text-[clamp(12px,1.1vw,14px)] leading-[1.85] text-night-100">
		{#each lines as line, i (i)}
			<p class="break-all">
				{#if line.kind === 'cmd'}
					<span class="text-rose">$</span> <span>{line.text}</span>
				{:else if line.kind === 'ok'}
					<span class="text-live">✓</span> <span>{line.text}</span>
				{:else}
					<span class="pl-4 text-night-300">{line.text}</span>
				{/if}
			</p>
		{/each}
		<p><span class="text-rose">$</span> <span class="caret text-night-300"></span></p>
	</div>
</div>
