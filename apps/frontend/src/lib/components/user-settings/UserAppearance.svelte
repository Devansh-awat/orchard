<script lang="ts">
	import { onMount } from 'svelte';
	import {
		themeStore,
		defaultLightTheme,
		defaultDarkTheme,
		builtInThemes,
		type Theme
	} from '$lib/stores/theme';
	import { toasts, projectGradientEnabled } from '$lib/stores';
	import ThemeEditor from '$lib/components/ThemeEditor.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Button, SectionCard, ToggleRow } from '$lib/components/ui';
	import {
		Plus,
		Download,
		Upload,
		Trash2,
		Copy,
		Check,
		Sun,
		Moon,
		Monitor,
		Pencil,
		X
	} from 'lucide-svelte';
	import { slide } from '$lib/utils/transitions';

	let allThemes = $state<Theme[]>([...builtInThemes]);
	let activeTheme = $state<Theme>(defaultLightTheme);
	let activeThemeId = $state<string | null>(null);

	$effect(() => {
		const unsubAll = themeStore.allThemes.subscribe((val) => {
			allThemes = val;
		});
		const unsubActive = themeStore.activeTheme.subscribe((val) => {
			activeTheme = val;
		});
		const unsubId = themeStore.activeThemeId.subscribe((val) => {
			activeThemeId = val;
		});
		return () => {
			unsubAll();
			unsubActive();
			unsubId();
		};
	});

	let editingTheme = $state<Theme | null>(null);
	let showDeleteThemeModal = $state(false);
	let themeToDelete = $state<Theme | null>(null);
	let showImportModal = $state(false);
	let importJson = $state('');
	let importError = $state<string | null>(null);
	let fileInput: HTMLInputElement;

	onMount(() => {
		themeStore.init();
	});

	function selectTheme(themeId: string) {
		themeStore.setActiveTheme(themeId);
		toasts.add({
			title: 'Theme applied',
			color: 'success'
		});
	}

	function useSystemTheme() {
		themeStore.setSystemTheme();
		toasts.add({
			title: 'Using system theme',
			description: 'Theme will follow your system preference',
			color: 'success'
		});
	}

	function startEditing(theme: Theme) {
		editingTheme = theme;
	}

	function stopEditing() {
		editingTheme = null;
		if (activeTheme) {
			themeStore.applyTheme(activeTheme);
		}
	}

	function duplicateTheme(theme: Theme) {
		const newTheme = themeStore.duplicateTheme(theme.id, `${theme.name} Copy`);
		if (newTheme) {
			toasts.add({
				title: 'Theme duplicated',
				description: `"${newTheme.name}" created`,
				color: 'success'
			});
			startEditing(newTheme);
		}
	}

	function confirmDeleteTheme(theme: Theme) {
		if (theme.isBuiltIn) return;
		themeToDelete = theme;
		showDeleteThemeModal = true;
	}

	function deleteTheme(theme: Theme) {
		themeStore.deleteTheme(theme.id);
		toasts.add({
			title: 'Theme deleted',
			color: 'success'
		});
	}

	function exportTheme(theme: Theme) {
		const json = themeStore.exportTheme(theme.id);
		if (!json) return;

		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${theme.name.toLowerCase().replace(/\s+/g, '-')}-theme.json`;
		a.click();
		URL.revokeObjectURL(url);

		toasts.add({
			title: 'Theme exported',
			description: 'Downloaded as JSON file',
			color: 'success'
		});
	}

	function openImportModal() {
		showImportModal = true;
		importJson = '';
		importError = null;
	}

	function closeImportModal() {
		showImportModal = false;
		importJson = '';
		importError = null;
	}

	function handleImport() {
		importError = null;
		const newTheme = themeStore.importTheme(importJson);
		if (newTheme) {
			toasts.add({
				title: 'Theme imported',
				description: `"${newTheme.name}" has been added`,
				color: 'success'
			});
			closeImportModal();
			themeStore.setActiveTheme(newTheme.id);
		} else {
			importError = 'Invalid theme format. Please check the JSON structure.';
		}
	}

	function handleFileImport(event: Event) {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			const content = e.target?.result as string;
			importJson = content;
			handleImport();
		};
		reader.onerror = () => {
			importError = 'Failed to read file';
		};
		reader.readAsText(file);

		target.value = '';
	}

	function createNewTheme() {
		const newTheme = themeStore.addTheme({
			name: 'New Theme',
			isDark: false,
			simpleColors: { ...defaultLightTheme.simpleColors }
		});
		themeStore.setActiveTheme(newTheme.id);
		startEditing(newTheme);
	}

	let gradientOn = $state(true);

	$effect(() => {
		const unsub = projectGradientEnabled.subscribe((v) => {
			gradientOn = v;
		});
		return unsub;
	});

	const customThemes = $derived(allThemes.filter((t) => !t.isBuiltIn));
	const lightPreview = defaultLightTheme.simpleColors;
	const darkPreview = defaultDarkTheme.simpleColors;
</script>

<div class="settings-body">
	{#if editingTheme}
		<div class="card" transition:slide={{ duration: 200 }}>
			<div class="card-header flex items-center justify-between">
				<h2 class="font-semibold">
					{editingTheme.isBuiltIn
						? `Customize ${editingTheme.name} Theme`
						: `Edit "${editingTheme.name}"`}
				</h2>
				<button type="button" class="btn btn-ghost" onclick={stopEditing}>
					<X class="h-4 w-4" />
					Close
				</button>
			</div>
			<div class="card-body">
				<ThemeEditor
					theme={editingTheme}
					onSave={() => {
						stopEditing();
					}}
					onCancel={stopEditing}
				/>
			</div>
		</div>
	{:else}
		<div class="ap-stack">
			<input
				type="file"
				accept=".json,application/json"
				class="hidden"
				bind:this={fileInput}
				onchange={handleFileImport}
			/>

			<SectionCard
				title="Themes"
				description="Pick how Orchard looks for you. Click a theme to apply it."
			>
				{#snippet actions()}
					<Button variant="secondary" size="sm" onclick={createNewTheme}>
						<Plus class="h-3.5 w-3.5" /> New theme
					</Button>
					<Button variant="ghost" size="sm" onclick={openImportModal}>
						<Upload class="h-3.5 w-3.5" /> Import
					</Button>
				{/snippet}
				<div class="ap-grid">
					<div class="ap-swatch" class:ap-swatch--active={!activeThemeId}>
						<button type="button" class="ap-swatch-main" onclick={useSystemTheme}>
							<span class="ap-preview ap-preview--split">
								<span class="ap-preview-half" style="background-color: {lightPreview.background};">
									<span class="ap-dot" style="background-color: {lightPreview.accent};"></span>
								</span>
								<span class="ap-preview-half" style="background-color: {darkPreview.background};">
									<span class="ap-dot" style="background-color: {darkPreview.accent};"></span>
								</span>
							</span>
							<span class="ap-meta">
								<Monitor size={13} />
								<span class="ap-name">System</span>
								{#if !activeThemeId}<span class="ap-check"><Check size={12} /></span>{/if}
							</span>
						</button>
					</div>

					{#each allThemes as theme (theme.id)}
						{@const c = theme.simpleColors}
						{@const isActive = activeThemeId === theme.id}
						<div class="ap-swatch" class:ap-swatch--active={isActive}>
							<button type="button" class="ap-swatch-main" onclick={() => selectTheme(theme.id)}>
								<span
									class="ap-preview"
									style="background-color: {c.background}; border-color: {c.border};"
								>
									<span class="ap-preview-side" style="background-color: {c.sidebarBackground};"
									></span>
									<span class="ap-preview-body">
										<span class="ap-line" style="background-color: {c.foreground};"></span>
										<span class="ap-line ap-line--dim" style="background-color: {c.muted};"></span>
										<span class="ap-dot" style="background-color: {c.accent};"></span>
									</span>
								</span>
								<span class="ap-meta">
									{#if theme.isDark}<Moon size={13} />{:else}<Sun size={13} />{/if}
									<span class="ap-name">{theme.name}</span>
									{#if isActive}<span class="ap-check"><Check size={12} /></span>{/if}
								</span>
							</button>
							<div class="ap-actions">
								<button
									type="button"
									class="ap-action"
									title="Customize"
									aria-label="Customize {theme.name}"
									onclick={() => startEditing(theme)}
								>
									<Pencil size={13} />
								</button>
								<button
									type="button"
									class="ap-action"
									title="Duplicate"
									aria-label="Duplicate {theme.name}"
									onclick={() => duplicateTheme(theme)}
								>
									<Copy size={13} />
								</button>
								<button
									type="button"
									class="ap-action"
									title="Export"
									aria-label="Export {theme.name}"
									onclick={() => exportTheme(theme)}
								>
									<Download size={13} />
								</button>
								{#if !theme.isBuiltIn}
									<button
										type="button"
										class="ap-action ap-action--danger"
										title="Delete"
										aria-label="Delete {theme.name}"
										onclick={() => confirmDeleteTheme(theme)}
									>
										<Trash2 size={13} />
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if customThemes.length === 0}
					<p class="ap-footnote">
						Duplicate a theme or create a new one to start customizing colors.
					</p>
				{/if}
			</SectionCard>

			<SectionCard title="Effects">
				<ToggleRow
					bind:checked={gradientOn}
					label="Project background gradient"
					hint="Animated gradient on project pages. Turn off to reduce motion or save GPU."
					onchange={() => projectGradientEnabled.set(gradientOn)}
				/>
			</SectionCard>
		</div>
	{/if}
</div>

{#if showImportModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onclick={closeImportModal}
	>
		<div
			class="w-full max-w-lg rounded-2xl border p-6 shadow-xl mx-4"
			style="background-color: var(--surface-bg); border-color: var(--surface-border);"
			onclick={(e) => e.stopPropagation()}
			transition:slide={{ duration: 200 }}
		>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">
					Import Theme
				</h2>
				<button type="button" class="btn btn-ghost" onclick={closeImportModal}>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-4">
				<div>
					<label
						for="import-json"
						class="block text-sm font-medium mb-2"
						style="color: var(--center-channel-color);"
					>
						Theme JSON
					</label>
					<textarea
						id="import-json"
						class="input min-h-[200px] font-mono text-sm"
						placeholder="Paste theme JSON here..."
						bind:value={importJson}
					></textarea>
				</div>

				{#if importError}
					<div class="alert alert-error">
						{importError}
					</div>
				{/if}

				<div class="text-center">
					<p class="text-sm mb-2" style="color: var(--surface-muted);">Or import from file</p>
					<button type="button" class="btn btn-secondary" onclick={() => fileInput?.click()}>
						<Upload class="h-4 w-4" />
						Choose File
					</button>
				</div>

				<div
					class="flex justify-end gap-2 pt-4 border-t"
					style="border-color: var(--divider-color);"
				>
					<button type="button" class="btn btn-secondary" onclick={closeImportModal}>
						Cancel
					</button>
					<button
						type="button"
						class="btn btn-primary"
						onclick={handleImport}
						disabled={!importJson.trim()}
					>
						Import Theme
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if themeToDelete}
	<ConfirmModal
		bind:open={showDeleteThemeModal}
		title={`Delete "${themeToDelete.name}"?`}
		description="This theme will be permanently deleted. This cannot be undone."
		confirmLabel="Delete Theme"
		danger
		onconfirm={() => {
			deleteTheme(themeToDelete!);
			themeToDelete = null;
		}}
		oncancel={() => {
			themeToDelete = null;
		}}
	/>
{/if}

<style>
	.ap-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.ap-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
		gap: 0.75rem;
	}

	.ap-swatch {
		position: relative;
		border: 1px solid var(--border-default);
		border-radius: 0.75rem;
		background: var(--bg-raised);
		overflow: hidden;
		transition: border-color 0.15s ease;
	}

	.ap-swatch:hover {
		border-color: var(--border-strong);
	}

	.ap-swatch--active {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	.ap-swatch-main {
		display: flex;
		flex-direction: column;
		width: 100%;
		border: none;
		background: transparent;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}

	.ap-preview {
		display: flex;
		width: 100%;
		height: 4.25rem;
		border-bottom: 1px solid var(--border-default);
	}

	.ap-preview--split .ap-preview-half {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ap-preview-side {
		width: 22%;
		opacity: 0.9;
	}

	.ap-preview-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.3rem;
		padding: 0 0.75rem;
	}

	.ap-line {
		display: block;
		height: 0.25rem;
		width: 55%;
		border-radius: 999px;
		opacity: 0.85;
	}

	.ap-line--dim {
		width: 35%;
		opacity: 0.45;
	}

	.ap-dot {
		display: block;
		height: 0.5rem;
		width: 1.5rem;
		border-radius: 999px;
	}

	.ap-meta {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.ap-meta :global(svg) {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.ap-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ap-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-fg, white);
	}

	.ap-check :global(svg) {
		color: inherit;
	}

	.ap-actions {
		position: absolute;
		top: 0.375rem;
		right: 0.375rem;
		display: flex;
		gap: 0.125rem;
		padding: 0.125rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--bg-raised) 85%, transparent);
		backdrop-filter: blur(4px);
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.ap-swatch:hover .ap-actions,
	.ap-actions:focus-within {
		opacity: 1;
	}

	.ap-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: 0.375rem;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.ap-action:hover {
		background: var(--accent-subtle);
		color: var(--text-default);
	}

	.ap-action--danger:hover {
		color: var(--status-error);
	}

	.ap-footnote {
		margin-top: 0.75rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
