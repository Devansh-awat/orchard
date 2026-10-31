<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Download, Ellipsis, Palette, Trash2, Upload } from 'lucide-svelte';
	import { themeStore, type SavedTheme } from '$lib/stores/theme';
	import { toasts, projectGradientEnabled } from '$lib/stores';
	import { specChip } from '$lib/theme/generate';
	import { specsEqual } from '$lib/theme/spec';
	import { LEGACY_THEMES } from '$lib/theme/legacy';
	import { FONT_OPTIONS, type FontId } from '$lib/theme/fonts';
	import ThemeStudio from '$lib/components/theme/ThemeStudio.svelte';
	import ThemeAdvanced from '$lib/components/theme/ThemeAdvanced.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import {
		Button,
		Disclosure,
		Dropdown,
		Field,
		Input,
		List,
		ListRow,
		Menu,
		MenuItem,
		Modal,
		ModalIntro,
		SectionCard,
		SettingRow,
		SettingsList,
		Textarea,
		ToggleRow
	} from '$lib/components/ui';
	import SwatchPicker from '$lib/components/ui/SwatchPicker.svelte';

	const activeScheme = themeStore.scheme;
	const savedThemes = themeStore.saved;
	const uid = $props.id();

	const state = $derived($themeStore);

	let naming = $state(false);
	let draftName = $state('');
	let advancedOpen = $state(false);
	let showImport = $state(false);
	let importJson = $state('');
	let importError = $state<string | null>(null);
	let pendingDelete = $state<SavedTheme | null>(null);
	let showDelete = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let gradientOn = $state(true);

	onMount(() => {
		themeStore.init();
		return projectGradientEnabled.subscribe((v) => {
			gradientOn = v;
		});
	});

	const overrideCount = $derived(Object.keys(state.overrides).length);
	const activeLegacyId = $derived(themeStore.matchLegacyId(state.overrides));
	const activeLegacyName = $derived(LEGACY_THEMES.find((t) => t.id === activeLegacyId)?.name);

	const CLASSIC_OPTIONS = LEGACY_THEMES.map((theme) => ({
		value: theme.id,
		label: theme.name,
		fill: theme.colours.background,
		dot: theme.colours.accent
	}));

	const FONT_CHOICES = FONT_OPTIONS.map((font) => ({
		value: font.id,
		label: font.name,
		description: font.hint
	}));

	function isApplied(theme: SavedTheme) {
		return specsEqual(theme.spec, state.spec);
	}

	function startNaming() {
		draftName = '';
		naming = true;
	}

	function saveTheme() {
		const entry = themeStore.saveCurrent(draftName);
		naming = false;
		toasts.add({ title: `Saved "${entry.name}"`, color: 'success' });
	}

	function exportTheme() {
		const json = themeStore.exportCurrent(draftName || 'Orchard theme');
		const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = 'orchard-theme.json';
		link.click();
		URL.revokeObjectURL(url);
		toasts.add({ title: 'Theme exported', color: 'success' });
	}

	function openImport() {
		importError = null;
		showImport = true;
	}

	function runImport() {
		importError = null;
		const entry = themeStore.importTheme(importJson);
		if (!entry) {
			importError = 'That does not look like an Orchard theme file.';
			return;
		}
		showImport = false;
		importJson = '';
		toasts.add({ title: `Imported "${entry.name}"`, color: 'success' });
	}

	function readFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			importJson = String(reader.result ?? '');
			runImport();
		};
		reader.onerror = () => {
			importError = 'Could not read that file.';
		};
		reader.readAsText(file);
		input.value = '';
	}
</script>

<input
	type="file"
	accept=".json,application/json"
	class="file-input"
	bind:this={fileInput}
	onchange={readFile}
/>

<SectionCard title="Theme" description="Drag the wheel to move every colour at once.">
	{#snippet actions()}
		<Button size="sm" onclick={startNaming}>Save theme</Button>
		<Menu>
			{#snippet trigger(props)}
				<Button {...props} size="sm" variant="ghost" icon={Ellipsis} label="More theme actions" />
			{/snippet}
			<MenuItem icon={Download} onclick={exportTheme}>Export</MenuItem>
			<MenuItem icon={Upload} onclick={openImport}>Import</MenuItem>
		</Menu>
	{/snippet}

	<ThemeStudio>
		{#snippet presets()}
			<SettingRow label="Classic" hint={activeLegacyName ?? 'Fixed colours from earlier Orchard'}>
				<SwatchPicker
					options={CLASSIC_OPTIONS}
					value={activeLegacyId}
					label="Classic themes"
					onchange={(id) => themeStore.applyLegacy(id)}
				/>
			</SettingRow>
		{/snippet}
	</ThemeStudio>

	<div class="advanced">
		<Disclosure
			title="Advanced colours"
			note={overrideCount ? `${overrideCount} pinned` : undefined}
			bind:open={advancedOpen}
		>
			<ThemeAdvanced />
		</Disclosure>
	</div>
</SectionCard>

{#if $savedThemes.length}
	<SectionCard title="Saved themes">
		<List inset={false} label="Saved themes">
			{#each $savedThemes as theme (theme.id)}
				{@const applied = isApplied(theme)}
				<ListRow
					flush
					presence
					title={theme.name}
					subtitle={applied ? 'In use' : undefined}
					onclick={() => themeStore.applySaved(theme.id)}
				>
					{#snippet leading()}
						<span class="chip" style:background-image={specChip(theme.spec, $activeScheme)}></span>
					{/snippet}
					{#snippet trailing()}
						{#if applied}<Check size={16} class="text-accent" />{/if}
					{/snippet}
					{#snippet actions()}
						<Button
							size="sm"
							variant="ghost"
							icon={Trash2}
							label={`Delete ${theme.name}`}
							onclick={() => {
								pendingDelete = theme;
								showDelete = true;
							}}
						/>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	</SectionCard>
{/if}

<SectionCard title="Interface">
	<SettingsList>
		<SettingRow
			label="Typeface"
			for="{uid}-font"
			hint="Hyperlegible and Dyslexic are drawn for readability"
		>
			<div class="picker">
				<Dropdown
					id="{uid}-font"
					options={FONT_CHOICES}
					value={state.font}
					placement="bottom-end"
					onchange={(v) => themeStore.setFont(v as FontId)}
				/>
			</div>
		</SettingRow>
		<ToggleRow
			bind:checked={gradientOn}
			label="Project background gradient"
			hint="Animated behind project pages. Turning it off saves GPU."
			onchange={() => projectGradientEnabled.set(gradientOn)}
		/>
	</SettingsList>
</SectionCard>

<Modal bind:open={naming} size="sm" closable={false} dismissable labelledby="{uid}-save">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			saveTheme();
		}}
	>
		<ModalIntro id="{uid}-save" icon={Palette} title="Save theme" />
		<Field label="Name" for="{uid}-name">
			<Input id="{uid}-name" bind:value={draftName} placeholder="Name this theme" />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" onclick={() => (naming = false)}>Cancel</Button>
		<Button variant="primary" shape="capsule" onclick={saveTheme}>Save theme</Button>
	{/snippet}
</Modal>

<Modal bind:open={showImport} size="md" closable={false} dismissable labelledby="{uid}-import">
	<div class="form">
		<ModalIntro
			id="{uid}-import"
			icon={Upload}
			title="Import theme"
			description="Paste an exported theme or choose its file."
		/>
		<Field label="Theme JSON" for="{uid}-json" error={importError}>
			<Textarea
				id="{uid}-json"
				mono
				rows={8}
				bind:value={importJson}
				placeholder="Paste an exported theme here"
			/>
		</Field>
	</div>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" onclick={() => fileInput?.click()}>Choose file</Button>
		<Button variant="primary" shape="capsule" disabled={!importJson.trim()} onclick={runImport}
			>Import</Button
		>
	{/snippet}
</Modal>

{#if pendingDelete}
	<ConfirmModal
		bind:open={showDelete}
		title={`Delete "${pendingDelete.name}"?`}
		description="This saved theme will be removed. Your current colours stay as they are."
		confirmLabel="Delete"
		danger
		onconfirm={() => {
			if (pendingDelete) themeStore.deleteSaved(pendingDelete.id);
			pendingDelete = null;
		}}
		oncancel={() => {
			pendingDelete = null;
		}}
	/>
{/if}

<style>
	.file-input {
		display: none;
	}
	.advanced {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.chip {
		display: block;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--neutral-10) 12%, transparent);
	}
	.picker {
		width: 15rem;
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
