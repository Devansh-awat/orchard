<script lang="ts">
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
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
	import { ChevronDown, RotateCcw } from 'lucide-svelte';
	import { Button, ColorField, Input, SegmentedControl } from '$lib/components/ui';
	import { springCollapse, springRotate } from '$lib/utils/motion.svelte';

	interface Props {
		theme: Theme;
		onSave?: () => void;
		onCancel?: () => void;
	}

	let { theme, onSave, onCancel }: Props = $props();

	const SCHEME_OPTIONS = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];

	const SURFACE_KEYS = [
		'background',
		'card',
		'foreground',
		'muted',
		'border',
		'sidebarBackground',
		'sidebarForeground'
	] as const satisfies readonly (keyof SimpleThemeColors)[];

	let editingColors = $state<SimpleThemeColors | null>(null);
	let themeName = $state('');
	let scheme = $state('light');
	let collapsed = $state<Record<string, boolean>>({ Sidebar: true, Status: true });
	let previousThemeId = $state('');
	let restored = false;

	const isDark = $derived(scheme === 'dark');

	$effect(() => {
		if (theme.id !== previousThemeId) {
			editingColors = { ...theme.simpleColors };
			themeName = theme.name;
			scheme = theme.isDark ? 'dark' : 'light';
			previousThemeId = theme.id;
		}
	});

	const safeEditingColors = $derived(editingColors ?? theme.simpleColors);

	const hasChanges = $derived.by(() => {
		if (!editingColors) return false;
		return (
			JSON.stringify(editingColors) !== JSON.stringify(theme.simpleColors) ||
			themeName !== theme.name ||
			isDark !== theme.isDark
		);
	});

	$effect(() => {
		if (!editingColors) return;
		const previewTheme: Theme = {
			...theme,
			name: themeName,
			isDark,
			simpleColors: editingColors,
			colors: generateThemeColors(editingColors, isDark)
		};
		themeStore.applyTheme(previewTheme, { persist: false });
	});

	function switchScheme(next: string) {
		if (next === scheme) return;
		const target = next === 'dark' ? defaultDarkTheme : defaultLightTheme;
		if (editingColors) {
			const swapped = { ...editingColors };
			for (const key of SURFACE_KEYS) swapped[key] = target.simpleColors[key];
			editingColors = swapped;
		}
		scheme = next;
		toasts.add({
			title: next === 'dark' ? 'Switched to dark' : 'Switched to light',
			description: 'Surface colors swapped. Your brand and status colors were kept.',
			color: 'success'
		});
	}

	function restoreActiveTheme() {
		if (restored) return;
		restored = true;
		const active = get(themeStore.activeTheme);
		if (active) themeStore.applyTheme(active);
	}

	onDestroy(restoreActiveTheme);

	function toggleCategory(name: string) {
		collapsed = { ...collapsed, [name]: !collapsed[name] };
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
			description: `Reset to the default ${isDark ? 'dark' : 'light'} palette`,
			color: 'success'
		});
	}

	function handleSave() {
		if (!themeName.trim()) {
			toasts.add({
				title: 'Name required',
				description: 'Give this theme a name before saving',
				color: 'error'
			});
			return;
		}
		if (!editingColors) return;

		restored = true;
		if (theme.isBuiltIn || theme.isDraft) {
			const newTheme = themeStore.addTheme({
				name: themeName,
				isDark,
				simpleColors: editingColors
			});
			themeStore.setActiveTheme(newTheme.id);
			toasts.add({ title: 'Theme created', description: `"${themeName}" saved`, color: 'success' });
		} else {
			themeStore.updateTheme(theme.id, { name: themeName, isDark, simpleColors: editingColors });
			themeStore.setActiveTheme(theme.id);
			toasts.add({ title: 'Theme updated', description: `"${themeName}" saved`, color: 'success' });
		}
		onSave?.();
	}

	function handleCancel() {
		restoreActiveTheme();
		onCancel?.();
	}
</script>

<div class="te-root">
	<div class="te-head">
		<div class="te-field">
			<label for="theme-name" class="te-field-label">Name</label>
			<Input
				id="theme-name"
				type="text"
				bind:value={themeName}
				placeholder="My theme"
				disabled={theme.isBuiltIn}
			/>
			{#if theme.isBuiltIn}
				<p class="te-field-hint">Built-in themes stay untouched. This saves as a new theme.</p>
			{/if}
		</div>
		<div class="te-field te-field--scheme">
			<span class="te-field-label">Color scheme</span>
			<SegmentedControl
				options={SCHEME_OPTIONS}
				value={scheme}
				label="Color scheme"
				onchange={switchScheme}
				grow
			/>
		</div>
	</div>

	<div
		class="te-preview"
		style="--p-bg: {safeEditingColors.background}; --p-card: {safeEditingColors.card}; --p-fg: {safeEditingColors.foreground}; --p-muted: {safeEditingColors.muted}; --p-border: {safeEditingColors.border}; --p-accent: {safeEditingColors.accent}; --p-accent-fg: {safeEditingColors.accentForeground}; --p-sidebar: {safeEditingColors.sidebarBackground}; --p-sidebar-fg: {safeEditingColors.sidebarForeground}; --p-success: {safeEditingColors.success}; --p-warning: {safeEditingColors.warning}; --p-error: {safeEditingColors.error}"
	>
		<div class="te-preview-rail">
			<span class="te-preview-rail-dot"></span>
			<span class="te-preview-rail-line"></span>
			<span class="te-preview-rail-line te-preview-rail-line--short"></span>
		</div>
		<div class="te-preview-body">
			<div class="te-preview-card">
				<p class="te-preview-title">Deployment</p>
				<p class="te-preview-sub">Running on 2 replicas</p>
				<div class="te-preview-row">
					<span class="te-preview-btn">Deploy</span>
					<span class="te-preview-dots">
						<span class="te-preview-dot te-preview-dot--success"></span>
						<span class="te-preview-dot te-preview-dot--warning"></span>
						<span class="te-preview-dot te-preview-dot--error"></span>
					</span>
				</div>
			</div>
		</div>
	</div>

	<div class="te-groups">
		{#each themeColorCategories as category (category.name)}
			<section class="te-group">
				<button
					type="button"
					class="te-group-head"
					aria-expanded={!collapsed[category.name]}
					onclick={() => toggleCategory(category.name)}
				>
					<span class="te-group-text">
						<span class="te-group-name">{category.name}</span>
						<span class="te-group-desc">{category.description}</span>
					</span>
					<span
						class="te-group-chevron"
						{@attach springRotate(() => !collapsed[category.name], { rest: -90, on: 0 })}
					>
						<ChevronDown class="h-4 w-4" />
					</span>
				</button>
				<div {@attach springCollapse(() => collapsed[category.name] ?? false)}>
					<div class="te-group-body">
						{#each category.colors as colorDef (colorDef.key)}
							{@const colorKey = colorDef.key as keyof SimpleThemeColors}
							<ColorField
								label={colorDef.label}
								description={colorDef.description}
								value={safeEditingColors[colorKey]}
								onchange={(next) => updateColor(colorKey, next)}
							/>
						{/each}
					</div>
				</div>
			</section>
		{/each}
	</div>

	<div class="te-actions">
		<Button variant="ghost" size="sm" onclick={resetToDefault}>
			<RotateCcw class="h-3.5 w-3.5" />
			Reset colors
		</Button>
		<div class="te-actions-right">
			{#if onCancel}
				<Button variant="secondary" size="sm" onclick={handleCancel}>Cancel</Button>
			{/if}
			<Button
				variant="primary"
				size="sm"
				onclick={handleSave}
				disabled={!hasChanges && !theme.isBuiltIn && !theme.isDraft}
			>
				{theme.isBuiltIn || theme.isDraft ? 'Create theme' : 'Save changes'}
			</Button>
		</div>
	</div>
</div>

<style>
	.te-root {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.te-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-4);
		align-items: start;
	}
	.te-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.te-field--scheme {
		min-width: 11rem;
	}
	.te-field-label {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}
	.te-field-hint {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.te-preview {
		display: flex;
		gap: 0;
		border-radius: var(--radius-md);
		overflow: hidden;
		border: 1px solid var(--border-default);
		background-color: var(--p-bg);
	}
	.te-preview-rail {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 4rem;
		flex-shrink: 0;
		padding: 0.75rem;
		background-color: var(--p-sidebar);
		border-right: 1px solid var(--p-border);
	}
	.te-preview-rail-dot {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: var(--radius-xs);
		background-color: var(--p-accent);
	}
	.te-preview-rail-line {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background-color: var(--p-sidebar-fg);
		opacity: 0.35;
	}
	.te-preview-rail-line--short {
		width: 60%;
	}
	.te-preview-body {
		flex: 1;
		min-width: 0;
		padding: 0.75rem;
		display: flex;
	}
	.te-preview-card {
		flex: 1;
		min-width: 0;
		padding: 0.625rem var(--space-3);
		border-radius: var(--radius-sm);
		background-color: var(--p-card);
		border: 1px solid var(--p-border);
	}
	.te-preview-title {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--p-fg);
	}
	.te-preview-sub {
		margin: 0.0625rem 0 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--p-muted);
	}
	.te-preview-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: 0.5rem;
	}
	.te-preview-btn {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--p-accent);
		color: var(--p-accent-fg);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
	}
	.te-preview-dots {
		display: inline-flex;
		gap: 0.25rem;
	}
	.te-preview-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
	}
	.te-preview-dot--success {
		background-color: var(--p-success);
	}
	.te-preview-dot--warning {
		background-color: var(--p-warning);
	}
	.te-preview-dot--error {
		background-color: var(--p-error);
	}

	.te-groups {
		display: flex;
		flex-direction: column;
	}
	.te-group {
		border-top: 1px solid var(--rule);
	}
	.te-group-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		padding: 0.875rem var(--space-3);
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		border-radius: var(--radius-md);
		transition: background-color var(--dur-fast);
	}
	.te-group-head:hover {
		background-color: var(--fill-quiet);
	}
	.te-group-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.te-group-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}
	.te-group-desc {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
	.te-group-chevron {
		display: inline-flex;
		color: var(--text-faint);
		flex-shrink: 0;
	}
	.te-group-body {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 var(--space-4);
		padding-bottom: var(--space-3);
	}

	.te-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		padding-top: var(--space-4);
		border-top: 1px solid var(--rule);
	}
	.te-actions-right {
		display: flex;
		gap: var(--space-2);
	}

	@media (max-width: 720px) {
		.te-head {
			grid-template-columns: 1fr;
		}
		.te-group-body {
			grid-template-columns: 1fr;
		}
		.te-preview-rail {
			width: 3.5rem;
		}
	}
</style>
