<script lang="ts">
	import { Pin, RotateCcw } from 'lucide-svelte';
	import { Button, ColorField } from '$lib/components/ui';
	import {
		composeColors,
		themeColorCategories,
		themeStore,
		type SimpleThemeColors
	} from '$lib/stores/theme';

	const activeScheme = themeStore.scheme;

	const state = $derived($themeStore);
	const generated = $derived(composeColors(state.spec, $activeScheme, {}).simple);
	const overrideCount = $derived(Object.keys(state.overrides).length);

	function currentValue(key: keyof SimpleThemeColors) {
		return state.overrides[key] ?? generated[key];
	}
</script>

<div class="adv">
	<div class="adv-head">
		<p class="adv-note">Colors you set here are pinned and stop following the wheel.</p>
		<Button
			variant="ghost"
			size="sm"
			icon={RotateCcw}
			disabled={overrideCount === 0}
			onclick={() => themeStore.clearOverrides()}>Reset all</Button
		>
	</div>

	{#each themeColorCategories as category (category.name)}
		<section class="adv-group" aria-label={category.name}>
			<h4 class="adv-group-title">{category.name}</h4>
			<div class="adv-grid">
				{#each category.colors as entry (entry.key)}
					{@const key = entry.key as keyof SimpleThemeColors}
					{@const pinned = state.overrides[key] !== undefined}
					<div class="adv-cell">
						<div class="adv-field">
							<ColorField
								label={entry.label}
								description={entry.description}
								value={currentValue(key)}
								onchange={(value) => themeStore.setOverride(key, value)}
							/>
						</div>
						{#if pinned}
							<Button
								variant="ghost"
								size="sm"
								icon={Pin}
								label={`Unpin ${entry.label}`}
								onclick={() => themeStore.setOverride(key, null)}
							/>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
</div>

<style>
	.adv {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.adv-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.adv-note {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}

	.adv-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.adv-group-title {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--text-muted);
	}

	.adv-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr));
		gap: var(--space-4) var(--space-6);
	}

	.adv-cell {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.adv-field {
		flex: 1 1 auto;
		min-width: 0;
	}
</style>
