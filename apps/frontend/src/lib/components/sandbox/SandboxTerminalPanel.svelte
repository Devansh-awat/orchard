<script lang="ts">
	import { Check, Copy, TerminalSquare } from 'lucide-svelte';

	let { name, running }: { name: string; running: boolean } = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	const command = $derived(`orchard sandbox ssh ${name}`);

	async function copyCommand() {
		await navigator.clipboard.writeText(command);
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="term-root">
	<div class="term-icon"><TerminalSquare class="h-5 w-5" /></div>
	<p class="term-title">Shell runs outside the browser</p>
	<p class="term-lede">
		{#if running}
			A shell needs a live socket to the sandbox, and the in-browser path is not wired up yet. Open
			one from the Orchard CLI instead.
		{:else}
			Start the sandbox, then open a shell from the Orchard CLI.
		{/if}
	</p>
	<div class="term-code-row">
		<code class="term-code">{command}</code>
		<button type="button" class="term-copy" aria-label="Copy shell command" onclick={copyCommand}>
			{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
		</button>
	</div>
	<p class="term-hint">
		Starts a stopped sandbox on demand. The Connect tab has an SSH config for plain ssh, scp, and
		VS Code Remote-SSH.
	</p>
</div>

<style>
	.term-root {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		padding: 1.25rem 0.875rem;
	}

	.term-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		color: var(--text-muted);
	}

	.term-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.term-lede {
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.term-code-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		width: 100%;
		margin-top: 0.25rem;
		padding: 0.375rem 0.375rem 0.375rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
	}

	.term-code {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		overflow-x: auto;
	}

	.term-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.term-copy:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.term-hint {
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-faint);
	}
</style>
