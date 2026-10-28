<script lang="ts">
	import { onMount } from 'svelte';
	import { themeStore } from '$lib/stores/theme';
	import { animationLevel } from '$lib/stores/preferences';
	import { PALETTE_PRESETS } from '$lib/theme/spec';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import { FONTS } from './fonts';

	let scheme = $state('light');
	let font = $state('default');
	let preset = $state('orchard');
	let motion = $state('full');

	function applyFonts() {
		const root = document.documentElement;
		root.style.setProperty('--font-sans', (FONTS.find((f) => f.id === font) ?? FONTS[0]).stack);
		localStorage.setItem('orchard-dev-font', font);
	}

	onMount(() => {
		themeStore.init();
		scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
		font = FONTS.some((f) => f.id === localStorage.getItem('orchard-dev-font'))
			? localStorage.getItem('orchard-dev-font')!
			: 'default';
		preset = localStorage.getItem('orchard-dev-preset') ?? 'orchard';
		motion = localStorage.getItem('animation-level') === 'reduced' ? 'reduced' : 'full';
		themeStore.applyPreset(preset);
		applyFonts();
		const unsub = themeStore.subscribe(() => queueMicrotask(applyFonts));
		return unsub;
	});
</script>

<div class="bar">
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
	<div class="pick">
		<Dropdown
			size="sm"
			placement="top-start"
			bind:value={preset}
			ariaLabel="Palette"
			options={PALETTE_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
			onchange={(v) => {
				themeStore.applyPreset(v);
				localStorage.setItem('orchard-dev-preset', v);
			}}
		/>
	</div>
	<div class="pick">
		<Dropdown
			size="sm"
			placement="top-start"
			bind:value={font}
			ariaLabel="Font"
			options={FONTS.map((f) => ({ value: f.id, label: f.label }))}
			onchange={applyFonts}
		/>
	</div>
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
	.pick {
		width: 9rem;
	}
</style>
