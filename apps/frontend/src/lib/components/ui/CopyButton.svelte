<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';

	let { value, label = 'Copy' }: { value: string; label?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		await navigator.clipboard.writeText(value);
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1400);
	}
</script>

<button
	type="button"
	class="copy"
	class:copy--done={copied}
	aria-label={copied ? 'Copied' : label}
	onclick={copy}
>
	<span class="icon icon--copy"><Copy size={14} /></span>
	<span class="icon icon--check"><Check size={14} /></span>
</button>

<style>
	.copy {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 0.375rem;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.copy:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.icon {
		grid-area: 1 / 1;
		display: flex;
		transition:
			opacity 120ms ease,
			transform var(--spring-bouncy-duration) var(--spring-bouncy);
	}
	.icon--check {
		color: var(--status-success);
		opacity: 0;
		transform: scale(0.5);
	}
	.copy--done .icon--copy {
		opacity: 0;
		transform: scale(0.5);
	}
	.copy--done .icon--check {
		opacity: 1;
		transform: none;
	}
</style>
