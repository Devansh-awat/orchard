<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Check,
		ChevronDown,
		Download,
		Palette,
		Sliders,
		Sparkles,
		Trash2,
		Type,
		Upload,
		X
	} from 'lucide-svelte';
	import { themeStore, type SavedTheme } from '$lib/stores/theme';
	import { toasts, projectGradientEnabled } from '$lib/stores';
	import { specChip } from '$lib/theme/generate';
	import { specsEqual } from '$lib/theme/spec';
	import { LEGACY_THEMES } from '$lib/theme/legacy';
	import ThemeStudio from '$lib/components/theme/ThemeStudio.svelte';
	import ThemeAdvanced from '$lib/components/theme/ThemeAdvanced.svelte';
	import FontPicker from '$lib/components/theme/FontPicker.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Alert, Button, Input, ToggleRow } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';
	import { slide } from '$lib/utils/transitions';

	const activeScheme = themeStore.scheme;
	const savedThemes = themeStore.saved;

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

<div class="settings-body">
	<div class="ap-stack">
		<input
			type="file"
			accept=".json,application/json"
			class="hidden"
			bind:this={fileInput}
			onchange={readFile}
		/>

		<SettingsSection
			index={0}
			title="Theme"
			description="Drag the field to move every colour at once. The palette keeps its own relationships, so it stays readable wherever you land."
		>
			{#snippet icon(_hovered)}<Palette class="h-[18px] w-[18px]" />{/snippet}
			{#snippet actions()}
				<div class="ap-head-actions">
					<Button variant="secondary" size="sm" onclick={startNaming}>Save</Button>
					<Button variant="ghost" size="sm" onclick={exportTheme}>
						<Download class="h-3.5 w-3.5" /> Export
					</Button>
					<Button variant="ghost" size="sm" onclick={() => (showImport = true)}>
						<Upload class="h-3.5 w-3.5" /> Import
					</Button>
				</div>
			{/snippet}

			<div class="ap-studio">
				<ThemeStudio />
			</div>

			{#if naming}
				<div class="ap-save" transition:slide={{ duration: 180 }}>
					<Input bind:value={draftName} placeholder="Name this theme" />
					<Button variant="primary" size="sm" onclick={saveTheme}>Save theme</Button>
					<Button variant="ghost" size="sm" onclick={() => (naming = false)}>Cancel</Button>
				</div>
			{/if}

			<div class="ap-saved">
				<span class="ap-saved-title">Classic</span>
				<div class="ap-saved-row">
					{#each LEGACY_THEMES as theme (theme.id)}
						{@const active = activeLegacyId === theme.id}
						<button
							type="button"
							class="ap-classic"
							class:ap-classic--on={active}
							onclick={() => themeStore.applyLegacy(theme.id)}
						>
							<span
								class="ap-classic-chip"
								style="background-color: {theme.colours.background}; color: {theme.colours.accent};"
							></span>
							<span class="ap-saved-name">{theme.name}</span>
							{#if active}<Check size={12} />{/if}
						</button>
					{/each}
				</div>
			</div>

			{#if $savedThemes.length}
				<div class="ap-saved">
					<span class="ap-saved-title">Saved</span>
					<div class="ap-saved-row">
						{#each $savedThemes as theme (theme.id)}
							{@const applied = isApplied(theme)}
							<div class="ap-saved-item" class:ap-saved-item--on={applied}>
								<button
									type="button"
									class="ap-saved-main"
									onclick={() => themeStore.applySaved(theme.id)}
								>
									<span
										class="ap-saved-chip"
										style="background-image: {specChip(theme.spec, $activeScheme)};"
									></span>
									<span class="ap-saved-name">{theme.name}</span>
									{#if applied}<Check size={12} />{/if}
								</button>
								<button
									type="button"
									class="ap-saved-del"
									aria-label="Delete {theme.name}"
									onclick={() => {
										pendingDelete = theme;
										showDelete = true;
									}}
								>
									<Trash2 size={13} />
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="ap-advanced">
				<button
					type="button"
					class="ap-advanced-toggle"
					aria-expanded={advancedOpen}
					onclick={() => (advancedOpen = !advancedOpen)}
				>
					<Sliders size={14} />
					<span>Advanced colours</span>
					{#if overrideCount}
						<span class="ap-advanced-count">{overrideCount} pinned</span>
					{/if}
					<ChevronDown size={14} class={advancedOpen ? 'ap-chev ap-chev--open' : 'ap-chev'} />
				</button>
				{#if advancedOpen}
					<div class="ap-advanced-body" transition:slide={{ duration: 200 }}>
						<ThemeAdvanced />
					</div>
				{/if}
			</div>
		</SettingsSection>

		<SettingsSection
			index={1}
			title="Typeface"
			description="Hyperlegible and Dyslexic are drawn for readability rather than style."
		>
			{#snippet icon(_hovered)}<Type class="h-[18px] w-[18px]" />{/snippet}
			<FontPicker />
		</SettingsSection>

		<SettingsSection index={2} title="Effects">
			{#snippet icon(_hovered)}<Sparkles class="h-[18px] w-[18px]" />{/snippet}
			<ToggleRow
				bind:checked={gradientOn}
				label="Project background gradient"
				hint="Animated gradient on project pages. Turn off to reduce motion or save GPU."
				onchange={() => projectGradientEnabled.set(gradientOn)}
			/>
		</SettingsSection>
	</div>
</div>

{#if showImport}
	<div class="ap-overlay">
		<div class="ap-modal" transition:slide={{ duration: 200 }}>
			<div class="ap-modal-head">
				<h2 class="ap-modal-title">Import theme</h2>
				<Button variant="ghost" size="sm" aria-label="Close" onclick={() => (showImport = false)}>
					<X class="h-4 w-4" />
				</Button>
			</div>
			<div class="ap-modal-body">
				<label class="ap-field-label" for="import-json">Theme JSON</label>
				<textarea
					id="import-json"
					class="ap-textarea"
					placeholder="Paste an exported theme here"
					bind:value={importJson}></textarea>
				{#if importError}
					<Alert tone="error">{importError}</Alert>
				{/if}
				<div class="ap-modal-foot">
					<Button variant="secondary" onclick={() => fileInput?.click()}>Choose file</Button>
					<Button variant="primary" disabled={!importJson.trim()} onclick={runImport}>
						Import
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}

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
	.ap-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.ap-head-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.ap-studio {
		max-width: 26rem;
		margin-inline: auto;
	}

	.ap-save {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-4);
		max-width: 26rem;
		margin-inline: auto;
	}

	.ap-saved {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-5);
	}

	.ap-saved-title {
		text-align: center;
		font-size: var(--text-caption);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.ap-saved-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}

	.ap-classic {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.625rem 0.3125rem 0.3125rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		color: var(--text-default);
		font-size: var(--text-footnote);
		font-weight: 600;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.ap-classic:hover {
		border-color: var(--border-strong);
	}

	.ap-classic--on {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.ap-classic-chip {
		position: relative;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.ap-classic-chip::after {
		content: '';
		position: absolute;
		inset: 28%;
		border-radius: 50%;
		background: currentColor;
	}

	.ap-saved-item {
		display: flex;
		align-items: center;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
	}

	.ap-saved-item--on {
		border-color: var(--accent);
	}

	.ap-saved-main {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.25rem 0.3125rem 0.3125rem;
		border: none;
		background: none;
		color: var(--text-default);
		font-size: var(--text-footnote);
		font-weight: 600;
		cursor: pointer;
	}

	.ap-saved-chip {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.ap-saved-name {
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ap-saved-del {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		margin-right: 0.1875rem;
		border: none;
		border-radius: 50%;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition: color var(--dur-fast) ease;
	}

	.ap-saved-del:hover {
		color: var(--status-error);
	}

	.ap-advanced {
		margin-top: var(--space-5);
		border-top: 1px solid var(--rule);
		padding-top: var(--space-3);
	}

	.ap-advanced-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		font-weight: 600;
		cursor: pointer;
	}

	.ap-advanced-toggle:hover {
		color: var(--text-default);
	}

	.ap-advanced-count {
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--accent-subtle);
		color: var(--text-link);
		font-size: var(--text-caption);
	}

	.ap-advanced-body {
		margin-top: var(--space-4);
	}

	.ap-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		background-color: rgb(0 0 0 / 0.5);
	}

	.ap-modal {
		width: 100%;
		max-width: 32rem;
		padding: var(--space-6);
		border-radius: var(--radius-2xl);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-4);
	}

	.ap-modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}

	.ap-modal-title {
		margin: 0;
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 600;
		color: var(--text-default);
	}

	.ap-modal-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.ap-field-label {
		font-size: var(--text-callout);
		font-weight: 600;
		color: var(--text-default);
	}

	.ap-textarea {
		width: 100%;
		min-height: 11rem;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background-color: var(--bg-surface);
		color: var(--text-default);
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		line-height: 1.5;
		resize: vertical;
	}

	.ap-textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.ap-modal-foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--rule);
	}
</style>
