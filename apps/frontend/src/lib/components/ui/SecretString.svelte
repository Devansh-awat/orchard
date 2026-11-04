<script lang="ts">
	import { Check, Copy, Eye, EyeOff } from 'lucide-svelte';
	import Spinner from './Spinner.svelte';

	let {
		masked,
		resolve,
		label = 'Secret'
	}: {
		masked: string;
		resolve: () => Promise<string | null>;
		label?: string;
	} = $props();

	let full = $state<string | null>(null);
	let revealed = $state(false);
	let busy = $state(false);
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		void masked;
		full = null;
		revealed = false;
	});

	async function load(): Promise<string | null> {
		if (full) return full;
		busy = true;
		try {
			full = await resolve();
			return full;
		} finally {
			busy = false;
		}
	}

	async function toggle() {
		if (revealed) {
			revealed = false;
			return;
		}
		if (await load()) revealed = true;
	}

	async function copy() {
		const text = await load();
		if (!text) return;
		await navigator.clipboard.writeText(text);
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1400);
	}
</script>

<div class="secret ph-no-capture">
	<code class="value" aria-label={label}>{revealed && full ? full : masked}</code>
	<div class="tools">
		<button
			type="button"
			class="tool"
			aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
			aria-pressed={revealed}
			disabled={busy}
			onclick={toggle}
		>
			{#if busy}<Spinner size={14} />{:else if revealed}<EyeOff size={14} />{:else}<Eye
					size={14}
				/>{/if}
		</button>
		<button
			type="button"
			class="tool"
			class:tool--done={copied}
			aria-label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
			disabled={busy}
			onclick={copy}
		>
			{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
		</button>
	</div>
</div>

<style>
	.secret {
		--secret-pad: 0.375rem;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		min-width: 0;
		padding: var(--secret-pad) var(--secret-pad) var(--secret-pad) 0.75rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		box-shadow: inset 0 0 0 1px var(--console-edge);
	}
	.value {
		flex: 1 1 auto;
		min-width: 0;
		padding-block: 0.25rem;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--console-text);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		user-select: all;
	}
	.tools {
		display: flex;
		flex-shrink: 0;
		gap: 0.125rem;
	}
	.tool {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: calc((var(--radius-control) - var(--secret-pad)) * var(--corner-scale));
		corner-shape: var(--corner);
		color: var(--text-muted);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.tool:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.tool:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.tool--done {
		color: var(--status-success);
	}
</style>
