<script lang="ts">
	import { Accessibility } from 'lucide-svelte';
	import SettingsSection from './SettingsSection.svelte';
	import { animationLevel, type AnimationLevel } from '$lib/stores';

	let { index = 0 }: { index?: number } = $props();

	const OPTIONS: { value: AnimationLevel; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows your system reduced motion setting' },
		{ value: 'full', label: 'Full', hint: 'Springs, staggers, and hover effects everywhere' },
		{
			value: 'reduced',
			label: 'Reduced',
			hint: 'Keeps state transitions, drops decorative motion'
		},
		{ value: 'off', label: 'Off', hint: 'No animation, everything changes instantly' }
	];

	const currentHint = $derived(OPTIONS.find((o) => o.value === $animationLevel)?.hint ?? '');
</script>

<SettingsSection {index} title="Accessibility">
	{#snippet icon(_hovered)}<Accessibility class="h-[18px] w-[18px]" />{/snippet}
	<div class="ua-row">
		<div class="ua-text">
			<span class="ua-title">Animation level</span>
			<span class="ua-hint">{currentHint}</span>
		</div>
		<div class="ua-seg" role="radiogroup" aria-label="Animation level">
			{#each OPTIONS as opt (opt.value)}
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
</SettingsSection>

<style>
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
		gap: 0.125rem;
		padding: 0.1875rem;
		border-radius: 0.625rem;
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		flex-shrink: 0;
	}

	.ua-seg-btn {
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

	.ua-seg-btn:hover {
		color: var(--text-default);
	}

	.ua-seg-btn--active {
		background-color: var(--bg-surface);
		color: var(--text-default);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
	}
</style>
