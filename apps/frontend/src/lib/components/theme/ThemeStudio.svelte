<script lang="ts">
	import { get } from 'svelte/store';
	import { ChevronLeft, ChevronRight, Minus, Moon, Plus, Sparkles, Sun } from 'lucide-svelte';
	import { themeStore } from '$lib/stores/theme';
	import {
		MAX_NODES,
		MIN_NODES,
		PALETTE_PRESETS,
		addNode,
		moveConstellation,
		removeNode,
		specNodes,
		type ThemeMode,
		type ThemeSpec
	} from '$lib/theme/spec';
	import { fieldFalloff, fieldWheel, nodeSwatch, specChip } from '$lib/theme/generate';
	import GrainDial from './GrainDial.svelte';

	const activeScheme = themeStore.scheme;

	const state = $derived($themeStore);
	const spec = $derived(state.spec);
	const wheel = $derived(fieldWheel($activeScheme));
	const falloff = $derived(fieldFalloff($activeScheme));
	const nodes = $derived(
		specNodes(spec).map((node) => ({ node, color: nodeSwatch(node, $activeScheme) }))
	);

	const MODES: { value: ThemeMode; label: string; hint: string }[] = [
		{ value: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
		{ value: 'light', label: 'Light', hint: 'Always light' },
		{ value: 'dark', label: 'Dark', hint: 'Always dark' }
	];

	let wheelEl = $state<HTMLDivElement | null>(null);
	let stripEl = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);

	function startDrag(event: PointerEvent) {
		if (!wheelEl || event.button !== 0) return;
		const rect = wheelEl.getBoundingClientRect();
		const origin = { x: event.clientX, y: event.clientY };
		const base = get(themeStore).spec;
		dragging = true;

		const move = (moveEvent: PointerEvent) => {
			themeStore.preview(
				moveConstellation(
					base,
					(moveEvent.clientX - origin.x) / rect.width,
					(moveEvent.clientY - origin.y) / rect.height
				)
			);
		};
		const end = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			window.removeEventListener('pointercancel', end);
			themeStore.setSpec(get(themeStore).spec);
		};

		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);
	}

	function nudge(event: KeyboardEvent) {
		const step = event.shiftKey ? 0.05 : 0.012;
		const deltas: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step]
		};
		const delta = deltas[event.key];
		if (!delta) return;
		event.preventDefault();
		themeStore.setSpec(moveConstellation(spec, delta[0], delta[1]));
	}

	function mutate(next: ThemeSpec) {
		themeStore.setSpec(next);
	}

	function scrollStrip(direction: -1 | 1) {
		stripEl?.scrollBy({ left: direction * 220, behavior: 'smooth' });
	}

	function setBlend(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value) / 100;
		themeStore.setSpec({ ...spec, blend: value });
	}
</script>

<div class="studio">
	<div class="studio-modes" role="radiogroup" aria-label="Appearance">
		{#each MODES as option (option.value)}
			<button
				type="button"
				role="radio"
				aria-checked={state.mode === option.value}
				class="studio-mode"
				class:studio-mode--on={state.mode === option.value}
				title={option.hint}
				onclick={() => themeStore.setMode(option.value)}
			>
				{#if option.value === 'auto'}
					<Sparkles size={16} />
				{:else if option.value === 'light'}
					<Sun size={16} />
				{:else}
					<Moon size={16} />
				{/if}
				<span class="studio-mode-label">{option.label}</span>
			</button>
		{/each}
	</div>

	<div class="studio-stage">
		<div
			bind:this={wheelEl}
			class="studio-wheel"
			class:studio-wheel--dragging={dragging}
			style="--field-wheel: {wheel}; --field-falloff: {falloff};"
		>
			<button
				type="button"
				class="studio-grab"
				aria-label="Colour wheel. Drag to move every colour together, arrow keys to nudge."
				onpointerdown={startDrag}
				onkeydown={nudge}
			></button>
			{#each nodes as entry, index (index)}
				<span
					class="studio-node"
					class:studio-node--lead={index === 0}
					style="left: {entry.node.x * 100}%; top: {entry.node.y *
						100}%; --node-color: {entry.color};"
				></span>
			{/each}
		</div>

		<div class="studio-count">
			<button
				type="button"
				class="studio-step"
				aria-label="Remove a colour"
				disabled={spec.count <= MIN_NODES}
				onclick={() => mutate(removeNode(spec))}
			>
				<Minus size={16} />
			</button>
			<span class="studio-count-value" aria-live="polite">
				{spec.count}
				{spec.count === 1 ? 'colour' : 'colours'}
			</span>
			<button
				type="button"
				class="studio-step"
				aria-label="Add a colour"
				disabled={spec.count >= MAX_NODES}
				onclick={() => mutate(addNode(spec))}
			>
				<Plus size={16} />
			</button>
		</div>
	</div>

	<div class="studio-strip-row">
		<button
			type="button"
			class="studio-arrow"
			aria-label="Scroll left"
			onclick={() => scrollStrip(-1)}
		>
			<ChevronLeft size={16} />
		</button>
		<div bind:this={stripEl} class="studio-strip" role="radiogroup" aria-label="Palette">
			{#each PALETTE_PRESETS as item (item.id)}
				<button
					type="button"
					role="radio"
					aria-checked={state.presetId === item.id}
					class="studio-chip"
					class:studio-chip--on={state.presetId === item.id}
					title={item.name}
					aria-label={item.name}
					style="--chip: {specChip(item.spec, $activeScheme)};"
					onclick={() => themeStore.applyPreset(item.id)}
				></button>
			{/each}
		</div>
		<button
			type="button"
			class="studio-arrow"
			aria-label="Scroll right"
			onclick={() => scrollStrip(1)}
		>
			<ChevronRight size={16} />
		</button>
	</div>

	<div class="studio-dials">
		<label class="studio-blend">
			<span class="studio-dial-label">Blend</span>
			<input
				type="range"
				min="0"
				max="100"
				step="1"
				value={Math.round(spec.blend * 100)}
				aria-label="Blend"
				oninput={setBlend}
			/>
		</label>
		<GrainDial value={spec.grain} onchange={(grain) => themeStore.setSpec({ ...spec, grain })} />
	</div>
</div>

<style>
	.studio {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.studio-modes {
		display: flex;
		align-self: center;
		gap: var(--space-1);
		padding: 0.1875rem;
		border-radius: var(--radius-pill);
		background: var(--fill-quiet);
	}

	.studio-mode {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.studio-mode:hover {
		color: var(--text-default);
	}

	.studio-mode--on {
		background: var(--bg-raised);
		color: var(--text-default);
		box-shadow: var(--elev-1);
	}

	.studio-mode-label {
		letter-spacing: var(--track-body);
	}

	.studio-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.75rem;
		padding: var(--space-2) 0;
	}

	.studio-wheel {
		position: relative;
		width: min(17rem, 100%);
		aspect-ratio: 1;
		border-radius: 50%;
		cursor: grab;
		touch-action: none;
		background-image: var(--field-falloff), var(--field-wheel);
		box-shadow:
			inset 0 0 0 1px var(--rule),
			var(--elev-2);
	}

	.studio-wheel--dragging {
		cursor: grabbing;
	}

	.studio-grab {
		position: absolute;
		inset: 0;
		width: 100%;
		border: none;
		border-radius: 50%;
		background: none;
		cursor: inherit;
	}

	.studio-grab:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
	}

	.studio-node {
		position: absolute;
		width: 2rem;
		height: 2rem;
		margin: -1rem 0 0 -1rem;
		border-radius: 50%;
		background: var(--node-color);
		box-shadow:
			0 0 0 3px var(--bg-raised),
			0 6px 16px rgb(0 0 0 / 0.18);
		pointer-events: none;
	}

	.studio-node--lead {
		width: 2.75rem;
		height: 2.75rem;
		margin: -1.375rem 0 0 -1.375rem;
		box-shadow:
			0 0 0 4px var(--bg-raised),
			0 10px 24px rgb(0 0 0 / 0.22);
	}

	.studio-count {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1875rem;
		border-radius: var(--radius-pill);
		background: var(--fill-quiet);
	}

	.studio-count-value {
		padding: 0 0.375rem;
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.studio-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--text-default);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}

	.studio-step:hover:not(:disabled) {
		background: var(--fill-soft);
	}

	.studio-step:disabled {
		color: var(--text-faint);
		cursor: not-allowed;
	}

	.studio-strip-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.studio-arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.studio-arrow:hover {
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.studio-strip {
		display: flex;
		flex: 1;
		min-width: 0;
		gap: var(--space-2);
		padding: 0.25rem;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.studio-strip::-webkit-scrollbar {
		display: none;
	}

	.studio-chip {
		width: 2.25rem;
		height: 2.25rem;
		flex-shrink: 0;
		border: 1px solid var(--rule);
		border-radius: 50%;
		background-image: var(--chip);
		cursor: pointer;
		transition:
			box-shadow var(--dur-fast) ease,
			transform var(--dur-fast) ease;
	}

	.studio-chip:hover {
		transform: scale(1.06);
	}

	.studio-chip--on {
		box-shadow:
			0 0 0 2px var(--bg-raised),
			0 0 0 4px var(--accent);
	}

	.studio-dials {
		display: flex;
		align-items: center;
		gap: var(--space-4);
	}

	.studio-blend {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 0.375rem;
	}

	.studio-dial-label {
		font-size: var(--text-caption);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.studio-blend input[type='range'] {
		width: 100%;
		height: 1.5rem;
		appearance: none;
		background: transparent;
		cursor: pointer;
	}

	.studio-blend input[type='range']::-webkit-slider-runnable-track {
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background: linear-gradient(to right, var(--fill-medium), var(--accent));
	}

	.studio-blend input[type='range']::-moz-range-track {
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background: linear-gradient(to right, var(--fill-medium), var(--accent));
	}

	.studio-blend input[type='range']::-webkit-slider-thumb {
		appearance: none;
		width: 1.25rem;
		height: 1.25rem;
		margin-top: -0.375rem;
		border: none;
		border-radius: 50%;
		background: var(--bg-raised);
		box-shadow: var(--elev-2);
	}

	.studio-blend input[type='range']::-moz-range-thumb {
		width: 1.25rem;
		height: 1.25rem;
		border: none;
		border-radius: 50%;
		background: var(--bg-raised);
		box-shadow: var(--elev-2);
	}
</style>
