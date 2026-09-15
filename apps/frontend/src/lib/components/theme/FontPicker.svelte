<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { themeStore } from '$lib/stores/theme';
	import { FONT_OPTIONS } from '$lib/theme/fonts';

	const state = $derived($themeStore);
</script>

<div class="fonts" role="radiogroup" aria-label="Interface typeface">
	{#each FONT_OPTIONS as option (option.id)}
		{@const active = state.font === option.id}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			class="font-card"
			class:font-card--on={active}
			style="--sample: {option.preview};"
			onclick={() => themeStore.setFont(option.id)}
		>
			<span class="font-sample">Ag</span>
			<span class="font-meta">
				<span class="font-name">{option.name}</span>
				<span class="font-hint">{option.hint}</span>
			</span>
			{#if active}
				<span class="font-check"><Check size={12} /></span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.fonts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
		gap: var(--space-2);
	}

	.font-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		padding: var(--space-3) 1.75rem var(--space-3) var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--bg-raised);
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.font-card:hover {
		border-color: var(--border-strong);
	}

	.font-card--on {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.font-sample {
		flex-shrink: 0;
		font-family: var(--sample);
		font-size: 1.5rem;
		line-height: 1.1;
		color: var(--text-default);
	}

	.font-meta {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.125rem;
	}

	.font-name {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.font-hint {
		font-size: var(--text-caption);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.font-check {
		position: absolute;
		top: 0.375rem;
		right: 0.375rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--text-on-accent);
	}
</style>
