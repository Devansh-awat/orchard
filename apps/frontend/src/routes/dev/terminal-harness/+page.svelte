<script lang="ts">
	import PodTerminal from '$lib/components/PodTerminal.svelte';
	import type { TerminalHandle } from '$lib/terminal';
	import type { PredictiveEcho } from '$lib/utils/terminal-predict';

	let { data } = $props();
	let width = $state(960);
	let height = $state(480);
	let visible = $state(true);

	function expose(handle: TerminalHandle, predictor: PredictiveEcho) {
		const w = window as unknown as Record<string, unknown>;
		w.__orchardTerminal = handle.term;
		w.__orchardTerminalHandle = handle;
		w.__orchardPredictor = predictor;
	}
</script>

<div class="harness">
	<div class="harness-controls">
		<label>width <input type="number" bind:value={width} step="40" /></label>
		<label>height <input type="number" bind:value={height} step="40" /></label>
		<label><input type="checkbox" bind:checked={visible} /> visible</label>
		<span data-testid="renderer"></span>
	</div>
	<div class="harness-frame" style="width:{width}px;height:{height}px">
		<PodTerminal endpoint={data.endpoint} {visible} onReady={expose} />
	</div>
</div>

<style>
	.harness {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		--console-bg: var(--bg-sunken);
		--console-quiet: var(--bg-raised);
		--console-faint: var(--text-faint);
	}
	.harness-controls {
		display: flex;
		gap: 1rem;
		font-size: var(--text-caption);
	}
	.harness-frame {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		overflow: hidden;
		transition:
			width 300ms ease,
			height 300ms ease;
	}
</style>
