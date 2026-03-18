<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import {
		themeStore,
		defaultLightTheme,
		defaultDarkTheme,
		type Theme
	} from '$lib/stores/theme';
	import { toasts } from '$lib/stores';
	import ThemeEditor from '$lib/components/ThemeEditor.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import {
		ArrowLeft,
		Palette,
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
	import { slide } from 'svelte/transition';

	let allThemes = $state<Theme[]>([defaultLightTheme, defaultDarkTheme]);
	let activeTheme = $state<Theme>(defaultLightTheme);
	let activeThemeId = $state<string | null>(null);

	// Subscribe to the stores
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
		// Reapply the current active theme
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
			// Start editing the new theme
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
			// Optionally start editing or apply the new theme
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
			// Auto-import
			handleImport();
		};
		reader.onerror = () => {
			importError = 'Failed to read file';
		};
		reader.readAsText(file);

		// Reset file input
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

	// Get a preview of theme colors
	function getThemePreviewColors(theme: Theme) {
		return {
			bg: theme.colors.centerChannelBg,
			sidebar: theme.colors.sidebarBg,
			primary: theme.colors.primary500,
			text: theme.colors.centerChannelColor
		};
	}
</script>

<div class="p-6">
	<div class="mb-6">
		<button
			onclick={() => window.history.back()}
			class="mb-4 inline-flex items-center gap-2 text-sm cursor-pointer"
			style="color: var(--surface-muted);"
		>
			<ArrowLeft class="h-4 w-4" />
			Back
		</button>

		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl"
				style="background-color: var(--sidebar-text-hover-bg); color: var(--sidebar-text);"
			>
				<Palette class="h-5 w-5" />
			</div>
			<div>
				<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
					Theme Settings
				</h1>
				<p class="text-sm" style="color: var(--surface-muted);">
					Customize the appearance of your workspace
				</p>
			</div>
		</div>
	</div>

	{#if editingTheme}
		<!-- Theme Editor View -->
		<div
			class="card"
			transition:slide={{ duration: 200 }}
		>
			<div class="card-header flex items-center justify-between">
				<h2 class="font-semibold">
					{editingTheme.isBuiltIn ? `Customize ${editingTheme.name} Theme` : `Edit "${editingTheme.name}"`}
				</h2>
				<button
					type="button"
					class="btn btn-ghost"
					onclick={stopEditing}
				>
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
		<!-- Theme Selection View -->
		<div class="space-y-6">
			<!-- Quick Actions -->
			<div class="flex flex-wrap gap-3">
				<button type="button" class="btn btn-primary" onclick={createNewTheme}>
					<Plus class="h-4 w-4" />
					Create Theme
				</button>
				<button type="button" class="btn btn-secondary" onclick={openImportModal}>
					<Upload class="h-4 w-4" />
					Import Theme
				</button>
				<input
					type="file"
					accept=".json,application/json"
					class="hidden"
					bind:this={fileInput}
					onchange={handleFileImport}
				/>
			</div>

			<!-- System Theme Option -->
			<div class="card">
				<div class="card-body">
					<button
						type="button"
						class="flex w-full items-center gap-4 rounded-xl p-4 transition-colors"
						class:ring-2={!activeThemeId}
						class:ring-primary-500={!activeThemeId}
						style="background-color: var(--control-bg);"
						onclick={useSystemTheme}
					>
						<div
							class="flex h-12 w-12 items-center justify-center rounded-lg"
							style="background-color: var(--surface-bg); border: 1px solid var(--surface-border);"
						>
							<Monitor class="h-6 w-6" style="color: var(--center-channel-color);" />
						</div>
						<div class="flex-1 text-left">
							<p class="font-medium" style="color: var(--center-channel-color);">
								System Preference
							</p>
							<p class="text-sm" style="color: var(--surface-muted);">
								Automatically switch between light and dark based on your system settings
							</p>
						</div>
						{#if !activeThemeId}
							<Check class="h-5 w-5 text-primary-600" />
						{/if}
					</button>
				</div>
			</div>

			<!-- Built-in Themes -->
			<div class="card">
				<div class="card-header">
					<h2 class="font-semibold">Built-in Themes</h2>
				</div>
				<div class="card-body">
					<div class="grid gap-4 sm:grid-cols-2">
						{#each [defaultLightTheme, defaultDarkTheme] as theme}
							{@const preview = getThemePreviewColors(theme)}
							{@const isActive = activeThemeId === theme.id}
							<div
								class="rounded-xl border overflow-hidden transition-all"
								class:ring-2={isActive}
								class:ring-primary-500={isActive}
								style="border-color: var(--surface-border);"
							>
								<!-- Color Preview -->
								<div class="h-20 flex">
									<div class="w-1/4" style="background-color: {preview.sidebar};"></div>
									<div class="flex-1 flex flex-col" style="background-color: {preview.bg};">
										<div class="flex-1 flex items-center justify-center">
											<div
												class="h-8 w-24 rounded"
												style="background-color: {preview.primary};"
											></div>
										</div>
									</div>
								</div>

								<!-- Theme Info -->
								<div
									class="p-4"
									style="background-color: var(--surface-bg);"
								>
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-2">
											{#if theme.isDark}
												<Moon class="h-4 w-4" style="color: var(--surface-muted);" />
											{:else}
												<Sun class="h-4 w-4" style="color: var(--surface-muted);" />
											{/if}
											<p class="font-medium" style="color: var(--center-channel-color);">
												{theme.name}
											</p>
											{#if isActive}
												<span class="badge badge-success text-xs">Active</span>
											{/if}
										</div>
									</div>

									<div class="mt-3 flex gap-2">
										<button
											type="button"
											class="btn btn-secondary flex-1"
											onclick={() => selectTheme(theme.id)}
											disabled={isActive}
										>
											{isActive ? 'Active' : 'Apply'}
										</button>
										<button
											type="button"
											class="btn btn-secondary"
											onclick={() => startEditing(theme)}
											title="Customize"
										>
											<Pencil class="h-4 w-4" />
										</button>
										<button
											type="button"
											class="btn btn-secondary"
											onclick={() => duplicateTheme(theme)}
											title="Duplicate"
										>
											<Copy class="h-4 w-4" />
										</button>
										<button
											type="button"
											class="btn btn-secondary"
											onclick={() => exportTheme(theme)}
											title="Export"
										>
											<Download class="h-4 w-4" />
										</button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>

			<!-- Custom Themes -->
			{#if allThemes.filter(t => !t.isBuiltIn).length > 0}
				<div class="card">
					<div class="card-header">
						<h2 class="font-semibold">Custom Themes</h2>
					</div>
					<div class="card-body">
						<div class="grid gap-4 sm:grid-cols-2">
							{#each allThemes.filter(t => !t.isBuiltIn) as theme}
								{@const preview = getThemePreviewColors(theme)}
								{@const isActive = activeThemeId === theme.id}
								<div
									class="rounded-xl border overflow-hidden transition-all"
									class:ring-2={isActive}
									class:ring-primary-500={isActive}
									style="border-color: var(--surface-border);"
								>
									<!-- Color Preview -->
									<div class="h-20 flex">
										<div class="w-1/4" style="background-color: {preview.sidebar};"></div>
										<div class="flex-1 flex flex-col" style="background-color: {preview.bg};">
											<div class="flex-1 flex items-center justify-center">
												<div
													class="h-8 w-24 rounded"
													style="background-color: {preview.primary};"
												></div>
											</div>
										</div>
									</div>

									<!-- Theme Info -->
									<div
										class="p-4"
										style="background-color: var(--surface-bg);"
									>
										<div class="flex items-center justify-between">
											<div class="flex items-center gap-2">
												{#if theme.isDark}
													<Moon class="h-4 w-4" style="color: var(--surface-muted);" />
												{:else}
													<Sun class="h-4 w-4" style="color: var(--surface-muted);" />
												{/if}
												<p class="font-medium" style="color: var(--center-channel-color);">
													{theme.name}
												</p>
												{#if isActive}
													<span class="badge badge-success text-xs">Active</span>
												{/if}
											</div>
										</div>

										<div class="mt-3 flex gap-2">
											<button
												type="button"
												class="btn btn-secondary flex-1"
												onclick={() => selectTheme(theme.id)}
												disabled={isActive}
											>
												{isActive ? 'Active' : 'Apply'}
											</button>
											<button
												type="button"
												class="btn btn-secondary"
												onclick={() => startEditing(theme)}
												title="Edit"
											>
												<Pencil class="h-4 w-4" />
											</button>
											<button
												type="button"
												class="btn btn-secondary"
												onclick={() => duplicateTheme(theme)}
												title="Duplicate"
											>
												<Copy class="h-4 w-4" />
											</button>
											<button
												type="button"
												class="btn btn-secondary"
												onclick={() => exportTheme(theme)}
												title="Export"
											>
												<Download class="h-4 w-4" />
											</button>
											<button
												type="button"
												class="btn btn-ghost text-red-600"
												onclick={() => confirmDeleteTheme(theme)}
												title="Delete"
											>
												<Trash2 class="h-4 w-4" />
											</button>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Import Modal -->
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
					<label for="import-json" class="block text-sm font-medium mb-2" style="color: var(--center-channel-color);">
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
					<button
						type="button"
						class="btn btn-secondary"
						onclick={() => fileInput?.click()}
					>
						<Upload class="h-4 w-4" />
						Choose File
					</button>
				</div>

				<div class="flex justify-end gap-2 pt-4 border-t" style="border-color: var(--divider-color);">
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
		title='Delete "{themeToDelete.name}"?'
		description='This theme will be permanently deleted. This cannot be undone.'
		confirmLabel="Delete Theme"
		danger
		onconfirm={() => { deleteTheme(themeToDelete!); themeToDelete = null; }}
		oncancel={() => { themeToDelete = null; }}
	/>
{/if}
