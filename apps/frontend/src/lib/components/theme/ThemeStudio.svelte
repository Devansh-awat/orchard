<script lang="ts">
	import type { Snippet } from 'svelte';
	import { get } from 'svelte/store';
	import { Moon, Sun, SunMoon } from 'lucide-svelte';
	import { SegmentedControl, SettingRow, SettingsList, Slider, Stepper } from '$lib/components/ui';
	import SwatchPicker from '$lib/components/ui/SwatchPicker.svelte';
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

	let { presets = undefined }: { presets?: Snippet } = $props();

	const activeScheme = themeStore.scheme;

	const state = $derived($themeStore);
	const spec = $derived(state.spec);
	const wheel = $derived(fieldWheel($activeScheme));
	const falloff = $derived(fieldFalloff($activeScheme));
	const nodes = $derived(
		specNodes(spec).map((node) => ({ node, color: nodeSwatch(node, $activeScheme) }))
	);

	const MODES = [
		{ value: 'auto', label: 'Auto', hint: 'Follows your system appearance', icon: SunMoon },
		{ value: 'light', label: 'Light', hint: 'Always light', icon: Sun },
		{ value: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon }
	];

	const modeHint = $derived(MODES.find((m) => m.value === state.mode)?.hint);
	const paletteOptions = $derived(
		PALETTE_PRESETS.map((item) => ({
			value: item.id,
			label: item.name,
			fill: specChip(item.spec, $activeScheme)
		}))
	);
	const paletteName = $derived(
		PALETTE_PRESETS.find((item) => item.id === state.presetId)?.name ?? 'Custom'
	);

	let wheelEl = $state<HTMLDivElement | null>(null);
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

	function setCount(next: number) {
		if (next > spec.count) mutate(addNode(spec));
		else if (next < spec.count) mutate(removeNode(spec));
	}
</script>

<div class="studio-frame">
	<div class="studio">
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
					aria-label="Color wheel. Drag to move every color together, or use the arrow keys."
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
		</div>

		<SettingsList label="Theme">
			<SettingRow label="Appearance" hint={modeHint}>
				<SegmentedControl
					options={MODES}
					value={state.mode}
					label="Appearance"
					onchange={(v) => themeStore.setMode(v as ThemeMode)}
				/>
			</SettingRow>
			<SettingRow label="Palette" hint={paletteName}>
				<SwatchPicker
					options={paletteOptions}
					value={state.presetId}
					label="Palette"
					onchange={(id) => themeStore.applyPreset(id)}
				/>
			</SettingRow>
			{@render presets?.()}
			<SettingRow label="Colors" hint="Points on the wheel">
				<Stepper
					label="Colors"
					size="sm"
					shape="capsule"
					min={MIN_NODES}
					max={MAX_NODES}
					value={spec.count}
					onchange={setCount}
				/>
			</SettingRow>
			<SettingRow label="Blend" hint="How much the colors tint surfaces">
				<div class="studio-dial">
					<Slider
						label="Blend"
						min={0}
						max={1}
						step={0.01}
						value={spec.blend}
						onchange={(blend) => themeStore.setSpec({ ...spec, blend })}
					/>
				</div>
			</SettingRow>
			<SettingRow label="Grain" hint="Noise texture over the background">
				<div class="studio-dial">
					<Slider
						label="Grain"
						min={0}
						max={1}
						step={0.01}
						value={spec.grain}
						onchange={(grain) => themeStore.setSpec({ ...spec, grain })}
					/>
				</div>
			</SettingRow>
		</SettingsList>
	</div>
</div>

<style>
	.studio-frame {
		container-type: inline-size;
	}

	.studio {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-6);
	}

	@container (min-width: 44rem) {
		.studio {
			grid-template-columns: 15rem minmax(0, 1fr);
			align-items: center;
		}
	}

	.studio-stage {
		display: flex;
		justify-content: center;
	}

	.studio-wheel {
		position: relative;
		width: min(15rem, 100%);
		aspect-ratio: 1;
		border-radius: 50%;
		cursor: grab;
		touch-action: none;
		background-image: var(--field-falloff), var(--field-wheel);
		box-shadow:
			inset 0 0 0 1px var(--border-default),
			var(--shadow-raised);
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
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.studio-node {
		position: absolute;
		width: 1.75rem;
		height: 1.75rem;
		margin: -0.875rem 0 0 -0.875rem;
		border-radius: 50%;
		background: var(--node-color);
		box-shadow:
			0 0 0 3px var(--bg-raised),
			0 6px 16px rgb(0 0 0 / 0.18);
		pointer-events: none;
	}

	.studio-node--lead {
		width: 2.5rem;
		height: 2.5rem;
		margin: -1.25rem 0 0 -1.25rem;
		box-shadow:
			0 0 0 4px var(--bg-raised),
			0 10px 24px rgb(0 0 0 / 0.22);
	}

	.studio-dial {
		width: 12rem;
	}
</style>
