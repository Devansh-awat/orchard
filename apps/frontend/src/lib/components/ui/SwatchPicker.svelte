<script lang="ts">
	import Tooltip from './Tooltip.svelte';

	interface Swatch {
		value: string;
		label: string;
		fill: string;
		dot?: string;
	}

	let {
		options,
		value = null,
		label,
		size = 24,
		onchange = undefined
	}: {
		options: readonly Swatch[];
		value?: string | null;
		label: string;
		size?: number;
		onchange?: (value: string) => void;
	} = $props();

	const buttons: Record<string, HTMLButtonElement> = $state({});
	const focusable = $derived(
		options.some((o) => o.value === value) ? value : (options[0]?.value ?? null)
	);

	function move(event: KeyboardEvent, index: number) {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (!step) return;
		event.preventDefault();
		const next = options[(index + step + options.length) % options.length];
		buttons[next.value]?.focus();
		onchange?.(next.value);
	}
</script>

<div class="swatches" role="radiogroup" aria-label={label} style:--swatch={`${size}px`}>
	{#each options as opt, i (opt.value)}
		<Tooltip text={opt.label} placement="bottom">
			<button
				bind:this={buttons[opt.value]}
				type="button"
				role="radio"
				class="swatch"
				aria-checked={value === opt.value}
				aria-label={opt.label}
				tabindex={focusable === opt.value ? 0 : -1}
				style:background={opt.fill}
				onclick={() => onchange?.(opt.value)}
				onkeydown={(e) => move(e, i)}
			>
				{#if opt.dot}<span class="dot" style:background={opt.dot}></span>{/if}
			</button>
		</Tooltip>
	{/each}
</div>

<style>
	.swatches {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem;
		margin: -0.25rem;
	}
	.swatch {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--swatch);
		height: var(--swatch);
		padding: 0;
		border: none;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--neutral-10) 12%, transparent);
		cursor: pointer;
		transition: transform var(--spring-press-duration) var(--spring-press);
	}
	.swatch::after {
		content: '';
		position: absolute;
		inset: -0.1875rem;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--accent);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
		pointer-events: none;
	}
	.swatch[aria-checked='true']::after {
		opacity: 1;
	}
	.swatch:hover:not([aria-checked='true'])::after {
		opacity: 0.35;
		box-shadow: 0 0 0 2px var(--border-strong);
	}
	.swatch:active {
		transform: scale(0.92);
	}
	.swatch:focus-visible {
		outline: none;
	}
	.swatch:focus-visible::after {
		opacity: 1;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	:global(html.motion-reduce) .swatch:active {
		transform: none;
	}
	.dot {
		width: 38%;
		height: 38%;
		border-radius: 50%;
	}
</style>
