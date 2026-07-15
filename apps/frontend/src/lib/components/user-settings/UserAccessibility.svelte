<script lang="ts">
	import { Accessibility } from 'lucide-svelte';
	import SettingsSection from './SettingsSection.svelte';
	import {
		animationLevel,
		contrastLevel,
		textScale,
		reduceTransparency,
		type AnimationLevel,
		type ContrastLevel,
		type TextScale
	} from '$lib/stores';

	let { index = 0 }: { index?: number } = $props();

	const ANIMATION_OPTIONS: { value: AnimationLevel; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows your system reduced motion setting' },
		{ value: 'full', label: 'Full', hint: 'Springs, staggers, and hover effects everywhere' },
		{
			value: 'reduced',
			label: 'Reduced',
			hint: 'Keeps state transitions, drops decorative motion'
		},
		{ value: 'off', label: 'Off', hint: 'No animation, everything changes instantly' }
	];

	const CONTRAST_OPTIONS: { value: ContrastLevel; label: string; hint: string }[] = [
		{ value: 'default', label: 'Default', hint: 'Standard colors and borders' },
		{ value: 'high', label: 'High', hint: 'Stronger text, borders, and status colors' }
	];

	const TEXT_OPTIONS: { value: TextScale; label: string; hint: string }[] = [
		{ value: 'sm', label: 'A', hint: 'Smaller text and interface' },
		{ value: 'md', label: 'A', hint: 'Default size' },
		{ value: 'lg', label: 'A', hint: 'Larger text and interface' },
		{ value: 'xl', label: 'A', hint: 'Largest text and interface' }
	];

	const animationHint = $derived(
		ANIMATION_OPTIONS.find((o) => o.value === $animationLevel)?.hint ?? ''
	);
	const contrastHint = $derived(
		CONTRAST_OPTIONS.find((o) => o.value === $contrastLevel)?.hint ?? ''
	);
	const textHint = $derived(TEXT_OPTIONS.find((o) => o.value === $textScale)?.hint ?? '');
</script>

<SettingsSection {index} title="Accessibility">
	{#snippet icon(_hovered)}<Accessibility class="h-[18px] w-[18px]" />{/snippet}

	<div class="ua-rows">
		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Animation level</span>
				<span class="ua-hint">{animationHint}</span>
			</div>
			<div class="ua-seg" role="radiogroup" aria-label="Animation level">
				{#each ANIMATION_OPTIONS as opt (opt.value)}
					<button
						type="button"
						role="radio"
						aria-checked={$animationLevel === opt.value}
						class="ua-seg-btn"
						class:ua-seg-btn--active={$animationLevel === opt.value}
						onclick={() => animationLevel.set(opt.value)}
					>
						{opt.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Contrast</span>
				<span class="ua-hint">{contrastHint}</span>
			</div>
			<div class="ua-seg" role="radiogroup" aria-label="Contrast">
				{#each CONTRAST_OPTIONS as opt (opt.value)}
					<button
						type="button"
						role="radio"
						aria-checked={$contrastLevel === opt.value}
						class="ua-seg-btn"
						class:ua-seg-btn--active={$contrastLevel === opt.value}
						onclick={() => contrastLevel.set(opt.value)}
					>
						{opt.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Text size</span>
				<span class="ua-hint">{textHint}</span>
			</div>
			<div class="ua-seg" role="radiogroup" aria-label="Text size">
				{#each TEXT_OPTIONS as opt, i (opt.value)}
					<button
						type="button"
						role="radio"
						aria-checked={$textScale === opt.value}
						aria-label={opt.hint}
						class="ua-seg-btn ua-seg-btn--a{i}"
						class:ua-seg-btn--active={$textScale === opt.value}
						onclick={() => textScale.set(opt.value)}
					>
						{opt.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Reduce transparency</span>
				<span class="ua-hint">Solid panels instead of glass and blur effects</span>
			</div>
			<div class="ua-seg" role="radiogroup" aria-label="Reduce transparency">
				<button
					type="button"
					role="radio"
					aria-checked={!$reduceTransparency}
					class="ua-seg-btn"
					class:ua-seg-btn--active={!$reduceTransparency}
					onclick={() => reduceTransparency.set(false)}
				>
					Off
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={$reduceTransparency}
					class="ua-seg-btn"
					class:ua-seg-btn--active={$reduceTransparency}
					onclick={() => reduceTransparency.set(true)}
				>
					On
				</button>
			</div>
		</div>
	</div>
</SettingsSection>

<style>
	.ua-rows {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.ua-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.ua-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.ua-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.ua-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.ua-seg {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.1875rem;
		border-radius: 0.625rem;
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		flex-shrink: 0;
	}

	.ua-seg-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2rem;
		border: none;
		background: none;
		padding: 0.3125rem 0.75rem;
		border-radius: 0.4375rem;
		font-size: 0.75rem;
		font-weight: 550;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease;
	}

	.ua-seg-btn--a0 {
		font-size: 0.6875rem;
	}

	.ua-seg-btn--a1 {
		font-size: 0.78125rem;
	}

	.ua-seg-btn--a2 {
		font-size: 0.875rem;
	}

	.ua-seg-btn--a3 {
		font-size: 0.96875rem;
	}

	.ua-seg-btn:hover {
		color: var(--text-default);
	}

	.ua-seg-btn--active {
		background-color: var(--bg-surface);
		color: var(--text-default);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
	}
</style>
