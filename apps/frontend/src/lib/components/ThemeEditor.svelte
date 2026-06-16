<script lang="ts">
	import {
		themeStore,
		themeColorCategories,
		defaultLightTheme,
		defaultDarkTheme,
		generateThemeColors,
		type Theme,
		type SimpleThemeColors
	} from '$lib/stores/theme';
	import { toasts } from '$lib/stores';
	import { ChevronDown, ChevronUp, Copy, RotateCcw, Check, X } from 'lucide-svelte';
	import { slide } from 'svelte/transition';

	interface Props {
		theme: Theme;
		onSave?: () => void;
		onCancel?: () => void;
	}

	let { theme, onSave, onCancel }: Props = $props();

	let editingColors = $state<SimpleThemeColors | null>(null);
	let themeName = $state('');
	let isDark = $state(false);
	let expandedCategories = $state<Set<string>>(new Set(['Brand', 'Base']));
	let previousThemeId = $state('');

	// Initialize/reset editing state when theme prop changes
	$effect(() => {
		if (theme.id !== previousThemeId) {
			editingColors = { ...theme.simpleColors };
			themeName = theme.name;
			isDark = theme.isDark;
			previousThemeId = theme.id;
		}
	});

	// Ensure editingColors is initialized
	let safeEditingColors = $derived(editingColors ?? theme.simpleColors);

	// Track changes
	let hasChanges = $derived.by(() => {
		if (!editingColors) return false;
		const colorsDiff = JSON.stringify(editingColors) !== JSON.stringify(theme.simpleColors);
		const nameDiff = themeName !== theme.name;
		const darkDiff = isDark !== theme.isDark;
		return colorsDiff || nameDiff || darkDiff;
	});

	// Live preview - apply colors as they change
	$effect(() => {
		if (!editingColors) return;
		const fullColors = generateThemeColors(editingColors, isDark);
		const previewTheme: Theme = {
			...theme,
			name: themeName,
			isDark,
			simpleColors: editingColors,
			colors: fullColors
		};
		themeStore.applyTheme(previewTheme);
	});

	function toggleCategory(name: string) {
		if (expandedCategories.has(name)) {
			expandedCategories.delete(name);
		} else {
			expandedCategories.add(name);
		}
		expandedCategories = new Set(expandedCategories);
	}

	function updateColor(key: keyof SimpleThemeColors, value: string) {
		if (!editingColors) return;
		editingColors = { ...editingColors, [key]: value };
	}

	function resetToDefault() {
		const baseTheme = isDark ? defaultDarkTheme : defaultLightTheme;
		editingColors = { ...baseTheme.simpleColors };
		toasts.add({
			title: 'Colors reset',
			description: `Reset to default ${isDark ? 'dark' : 'light'} theme colors`,
			color: 'success'
		});
	}

	function handleSave() {
		if (!themeName.trim()) {
			toasts.add({
				title: 'Name required',
				description: 'Please enter a name for this theme',
				color: 'error'
			});
			return;
		}

		if (!editingColors) return;

		if (theme.isBuiltIn) {
			// Create a new theme based on built-in
			const newTheme = themeStore.addTheme({
				name: themeName,
				isDark,
				simpleColors: editingColors
			});
			themeStore.setActiveTheme(newTheme.id);
			toasts.add({
				title: 'Theme created',
				description: `"${themeName}" has been saved`,
				color: 'success'
			});
		} else {
			// Update existing custom theme
			themeStore.updateTheme(theme.id, {
				name: themeName,
				isDark,
				simpleColors: editingColors
			});
			toasts.add({
				title: 'Theme updated',
				description: `"${themeName}" has been saved`,
				color: 'success'
			});
		}

		onSave?.();
	}

	function handleCancel() {
		// Revert to the original theme
		themeStore.applyTheme(theme);
		onCancel?.();
	}

	function copyColor(color: string) {
		navigator.clipboard.writeText(color);
		toasts.add({
			title: 'Copied',
			description: color,
			color: 'success'
		});
	}
</script>

<div class="space-y-6">
	<!-- Theme name and mode -->
	<div class="grid gap-4 sm:grid-cols-2">
		<div>
			<label
				for="theme-name"
				class="block text-sm font-medium mb-2"
				style="color: var(--center-channel-color);"
			>
				Theme Name
			</label>
			<input
				id="theme-name"
				type="text"
				class="input"
				bind:value={themeName}
				placeholder="My Custom Theme"
				disabled={theme.isBuiltIn}
			/>
			{#if theme.isBuiltIn}
				<p class="mt-1 text-xs" style="color: var(--surface-muted);">
					Built-in themes can't be edited. Changes will be saved as a new theme.
				</p>
			{/if}
		</div>
		<div>
			<label class="block text-sm font-medium mb-2" style="color: var(--center-channel-color);">
				Color Scheme
			</label>
			<div class="flex gap-2">
				<button
					type="button"
					class="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
					class:bg-primary-600={!isDark}
					class:text-white={!isDark}
					style={isDark
						? `background-color: var(--control-bg); color: var(--control-text); border: 1px solid var(--surface-border);`
						: ''}
					onclick={() => (isDark = false)}
				>
					Light
				</button>
				<button
					type="button"
					class="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
					class:bg-primary-600={isDark}
					class:text-white={isDark}
					style={!isDark
						? `background-color: var(--control-bg); color: var(--control-text); border: 1px solid var(--surface-border);`
						: ''}
					onclick={() => (isDark = true)}
				>
					Dark
				</button>
			</div>
		</div>
	</div>

	<!-- Color categories -->
	<div class="space-y-3">
		{#each themeColorCategories as category}
			<div
				class="rounded-xl border overflow-hidden"
				style="background-color: var(--surface-bg); border-color: var(--surface-border);"
			>
				<button
					type="button"
					class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors"
					style="color: var(--center-channel-color);"
					onclick={() => toggleCategory(category.name)}
				>
					<div>
						<p class="font-medium">{category.name}</p>
						<p class="text-xs" style="color: var(--surface-muted);">{category.description}</p>
					</div>
					{#if expandedCategories.has(category.name)}
						<ChevronUp class="h-5 w-5" style="color: var(--surface-muted);" />
					{:else}
						<ChevronDown class="h-5 w-5" style="color: var(--surface-muted);" />
					{/if}
				</button>

				{#if expandedCategories.has(category.name)}
					<div
						class="border-t px-4 py-4"
						style="border-color: var(--surface-border);"
						transition:slide={{ duration: 200 }}
					>
						<div class="grid gap-4 sm:grid-cols-2">
							{#each category.colors as colorDef}
								{@const colorKey = colorDef.key as keyof SimpleThemeColors}
								{@const colorValue = safeEditingColors[colorKey]}
								<div
									class="flex items-center gap-3 p-3 rounded-lg"
									style="background-color: var(--control-bg);"
								>
									<div class="relative">
										<input
											type="color"
											value={colorValue}
											oninput={(e) => updateColor(colorKey, e.currentTarget.value)}
											class="h-12 w-12 cursor-pointer rounded-lg border-2 p-0.5"
											style="border-color: var(--surface-border); background-color: var(--surface-bg);"
										/>
									</div>
									<div class="flex-1 min-w-0">
										<p class="text-sm font-medium" style="color: var(--center-channel-color);">
											{colorDef.label}
										</p>
										<p class="text-xs mb-1" style="color: var(--surface-muted);">
											{colorDef.description}
										</p>
										<button
											type="button"
											class="flex items-center gap-1 text-xs font-mono transition-colors hover:opacity-70"
											style="color: var(--surface-muted);"
											onclick={() => copyColor(colorValue)}
										>
											{colorValue}
											<Copy class="h-3 w-3" />
										</button>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Actions -->
	<div
		class="flex flex-wrap items-center justify-between gap-4 pt-4 border-t"
		style="border-color: var(--divider-color);"
	>
		<div class="flex gap-2">
			<button type="button" class="btn btn-secondary" onclick={resetToDefault}>
				<RotateCcw class="h-4 w-4" />
				Reset to Default
			</button>
		</div>
		<div class="flex gap-2">
			{#if onCancel}
				<button type="button" class="btn btn-secondary" onclick={handleCancel}>
					<X class="h-4 w-4" />
					Cancel
				</button>
			{/if}
			<button
				type="button"
				class="btn btn-primary"
				onclick={handleSave}
				disabled={!hasChanges && !theme.isBuiltIn}
			>
				<Check class="h-4 w-4" />
				{theme.isBuiltIn ? 'Save as New Theme' : 'Save Changes'}
			</button>
		</div>
	</div>
</div>
