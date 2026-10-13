<script lang="ts">
	import { fmtElapsed } from '../steps';
	import Pip from '../../../greenhouse/mascot/Pip.svelte';

	let { start = null, label }: { start?: number | null; label: string } = $props();

	const mounted = Date.now();
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const elapsed = $derived(fmtElapsed(now - (start ?? mounted)));
</script>

<div class="work" data-align="step">
	<span class="work-glyph"><Pip pose="thinking" size={18} /></span>
	<span class="work-time" role="timer">{elapsed}</span>
	<span class="work-sep" aria-hidden="true">·</span>
	<span class="work-label" role="status" aria-live="polite">{label}</span>
</div>

<style>
	.work {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		min-height: 2rem;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.work-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1rem;
		height: 1.125rem;
	}

	.work-time {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
	}

	.work-sep {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.work-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
