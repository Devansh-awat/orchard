<script lang="ts">
	import { RotateCcw } from 'lucide-svelte';
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
		<p class="adv-note">
			These start from whatever the palette generates. Anything you set here is pinned and stops
			following the nodes.
		</p>
		<Button
			variant="ghost"
			size="sm"
			disabled={overrideCount === 0}
			onclick={() => themeStore.clearOverrides()}
		>
			<RotateCcw class="h-3.5 w-3.5" />
			Reset {overrideCount ? `(${overrideCount})` : ''}
		</Button>
	</div>

	{#each themeColorCategories as category (category.name)}
		<section class="adv-group">
			<h4 class="adv-group-title">{category.name}</h4>
			<div class="adv-grid">
				{#each category.colors as entry (entry.key)}
					{@const key = entry.key as keyof SimpleThemeColors}
					{@const pinned = state.overrides[key] !== undefined}
					<div class="adv-cell" class:adv-cell--pinned={pinned}>
						<ColorField
							label={entry.label}
							description={entry.description}
							value={currentValue(key)}
							onchange={(value) => themeStore.setOverride(key, value)}
						/>
						{#if pinned}
							<button
								type="button"
								class="adv-unpin"
								onclick={() => themeStore.setOverride(key, null)}
							>
								Back to generated
							</button>
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
		gap: var(--space-5);
	}

	.adv-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.adv-note {
		margin: 0;
		max-width: 38rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.adv-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.adv-group-title {
		margin: 0;
		font-size: var(--text-caption);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.adv-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: var(--space-2);
	}

	.adv-cell {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: var(--space-2);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
	}

	.adv-cell--pinned {
		border-color: var(--border-default);
		background: var(--fill-quiet);
	}

	.adv-unpin {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-link);
		font-size: var(--text-caption);
		cursor: pointer;
	}

	.adv-unpin:hover {
		text-decoration: underline;
	}
</style>
