<script lang="ts">
	import { stretchIndicator } from './slide.svelte';

	interface Option {
		value: string;
		label: string;
		hint?: string;
		optionClass?: string;
	}

	let {
		options,
		value = $bindable(''),
		label,
		onchange = undefined,
		grow = false,
		size = 'md'
	}: {
		options: readonly Option[];
		value: string;
		label: string;
		onchange?: (value: string) => void;
		grow?: boolean;
		size?: 'md' | 'sm';
	} = $props();

	const buttons: Record<string, HTMLButtonElement> = $state({});

	function select(next: string) {
		value = next;
		onchange?.(next);
	}
</script>

<div class="seg seg--{size}" class:seg--grow={grow} role="radiogroup" aria-label={label}>
	<span class="thumb" aria-hidden="true" {@attach stretchIndicator(() => buttons[value])}></span>
	{#each options as opt (opt.value)}
		<button
			bind:this={buttons[opt.value]}
			type="button"
			role="radio"
			aria-checked={value === opt.value}
			aria-label={opt.hint}
			class="opt {opt.optionClass ?? ''}"
			class:opt--active={value === opt.value}
			onclick={() => select(opt.value)}
		>
			{opt.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		width: fit-content;
		padding: 0.125rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-active);
	}
	.seg--grow {
		display: flex;
		width: 100%;
	}
	.seg--grow .opt {
		flex: 1;
	}
	.thumb {
		position: absolute;
		top: 0;
		left: 0;
		border-radius: calc(var(--radius-control) - 0.125rem);
		background: var(--bg-raised);
		box-shadow:
			0 0 0 0.5px rgb(0 0 0 / 0.06),
			0 1px 2px rgb(0 0 0 / 0.1),
			0 2px 6px rgb(0 0 0 / 0.04);
		pointer-events: none;
		will-change: transform;
	}
	.opt {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		height: 1.75rem;
		min-width: 2rem;
		padding: 0 0.75rem;
		border: none;
		border-radius: calc(var(--radius-control) - 0.125rem);
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			transform var(--spring-interactive-duration) var(--spring-interactive);
	}
	.opt:active {
		transform: scale(0.96);
	}
	:global(html.motion-reduce) .opt:active {
		transform: none;
	}
	.seg--sm .opt {
		height: 1.5rem;
		padding: 0 0.5rem;
		font-size: var(--text-caption);
	}
	.opt:hover,
	.opt--active {
		color: var(--text-default);
	}
</style>
