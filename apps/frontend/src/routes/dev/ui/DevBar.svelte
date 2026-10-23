<script lang="ts">
	import { onMount } from 'svelte';
	import { themeStore } from '$lib/stores/theme';
	import { animationLevel } from '$lib/stores/preferences';
	import { PALETTE_PRESETS } from '$lib/theme/spec';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { FONTS, GOOGLE_FONTS, MONOS } from './fonts';

	let look = $state('evolve');
	let scheme = $state('light');
	let font = $state('jakarta');
	let mono = $state('jetbrains');
	let preset = $state('orchard');
	let motion = $state('full');

	function applyFonts() {
		const root = document.documentElement;
		root.style.setProperty('--font-sans', FONTS.find((f) => f.id === font)!.stack);
		const m = MONOS.find((f) => f.id === mono)!.stack;
		root.style.setProperty('--font-mono', m);
		root.style.setProperty('--font-mono-terminal', m);
		localStorage.setItem('orchard-dev-font', font);
		localStorage.setItem('orchard-dev-mono', mono);
	}

	onMount(() => {
		themeStore.init();
		look = document.documentElement.dataset.look ?? 'evolve';
		scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
		font = localStorage.getItem('orchard-dev-font') ?? 'jakarta';
		mono = localStorage.getItem('orchard-dev-mono') ?? 'jetbrains';
		preset = localStorage.getItem('orchard-dev-preset') ?? 'orchard';
		motion = localStorage.getItem('animation-level') === 'reduced' ? 'reduced' : 'full';
		themeStore.applyPreset(preset);
		applyFonts();
		const unsub = themeStore.subscribe(() => queueMicrotask(applyFonts));
		return unsub;
	});
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link rel="stylesheet" href={GOOGLE_FONTS} />
</svelte:head>

<div class="bar">
	<SegmentedControl
		label="Look"
		size="sm"
		bind:value={look}
		options={[
			{ value: 'evolve', label: 'Evolve' },
			{ value: 'quiet', label: 'Quiet' }
		]}
		onchange={(v) => {
			document.documentElement.dataset.look = v;
			localStorage.setItem('orchard-look', v);
		}}
	/>
	<SegmentedControl
		label="Scheme"
		size="sm"
		bind:value={scheme}
		options={[
			{ value: 'light', label: 'Light' },
			{ value: 'dark', label: 'Dark' }
		]}
		onchange={(v) => themeStore.setMode(v as 'light' | 'dark')}
	/>
	<SegmentedControl
		label="Motion"
		size="sm"
		bind:value={motion}
		options={[
			{ value: 'full', label: 'Full' },
			{ value: 'reduced', label: 'Reduced' }
		]}
		onchange={(v) => animationLevel.set(v as 'full' | 'reduced')}
	/>
	<Select
		size="sm"
		bind:value={preset}
		aria-label="Palette"
		onchange={() => {
			themeStore.applyPreset(preset);
			localStorage.setItem('orchard-dev-preset', preset);
		}}
	>
		{#each PALETTE_PRESETS as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
	</Select>
	<Select size="sm" bind:value={font} aria-label="Font" onchange={applyFonts}>
		{#each FONTS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
	</Select>
	<Select size="sm" bind:value={mono} aria-label="Mono font" onchange={applyFonts}>
		{#each MONOS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
	</Select>
</div>

<style>
	.bar {
		position: fixed;
		bottom: 1rem;
		left: 50%;
		z-index: var(--z-nav);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem;
		border-radius: var(--radius-panel);
		background: var(--material-glass-bg);
		backdrop-filter: var(--material-glass-filter);
		box-shadow: var(--shadow-floating);
		transform: translateX(-50%);
	}
	.bar :global(.wrap) {
		width: 9rem;
	}
</style>
