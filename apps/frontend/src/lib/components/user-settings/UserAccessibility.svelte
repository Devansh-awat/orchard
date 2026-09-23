<script lang="ts">
	import { Accessibility } from 'lucide-svelte';
	import SettingsSection from './SettingsSection.svelte';
	import { SegmentedControl } from '$lib/components/ui';
	import {
		animationLevel,
		contrastLevel,
		textScale,
		reduceTransparency,
		soundCues,
		type AnimationLevel,
		type ContrastLevel,
		type TextScale
	} from '$lib/stores';
	import { previewCue } from '$lib/utils/sound';

	let { index = 0 }: { index?: number } = $props();

	const ANIMATION_OPTIONS: { value: AnimationLevel; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows your system reduced motion setting' },
		{ value: 'full', label: 'Full', hint: 'Springs, staggers, and hover effects everywhere' },
		{
			value: 'reduced',
			label: 'Reduced',
			hint: 'Quick fades only, nothing slides or scales'
		},
		{ value: 'off', label: 'Off', hint: 'Nothing animates, including background gradients' }
	];

	const CONTRAST_OPTIONS: { value: ContrastLevel; label: string; hint: string }[] = [
		{ value: 'default', label: 'Default', hint: 'Standard colors and borders' },
		{ value: 'high', label: 'High', hint: 'Darker text and visible borders on everything' }
	];

	const TEXT_OPTIONS: { value: TextScale; label: string; hint: string; optionClass: string }[] = [
		{ value: 'sm', label: 'A', hint: 'Smaller text and interface', optionClass: 'ua-a0' },
		{ value: 'md', label: 'A', hint: 'Default size', optionClass: 'ua-a1' },
		{ value: 'lg', label: 'A', hint: 'Larger text and interface', optionClass: 'ua-a2' },
		{ value: 'xl', label: 'A', hint: 'Largest text and interface', optionClass: 'ua-a3' }
	];

	const TRANSPARENCY_OPTIONS = [
		{ value: 'off', label: 'Off' },
		{ value: 'on', label: 'On' }
	];

	const SOUND_OPTIONS = [
		{ value: 'off', label: 'Off', hint: 'Silent' },
		{ value: 'on', label: 'On', hint: 'A short cue when a build you are waiting on finishes' }
	];

	const soundHint = $derived(
		SOUND_OPTIONS.find((o) => o.value === ($soundCues ? 'on' : 'off'))?.hint ?? ''
	);

	function setSound(v: string) {
		const on = v === 'on';
		soundCues.set(on);
		if (on) previewCue();
	}

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
			<SegmentedControl
				options={ANIMATION_OPTIONS}
				value={$animationLevel}
				label="Animation level"
				onchange={(v) => animationLevel.set(v as AnimationLevel)}
			/>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Contrast</span>
				<span class="ua-hint">{contrastHint}</span>
			</div>
			<SegmentedControl
				options={CONTRAST_OPTIONS}
				value={$contrastLevel}
				label="Contrast"
				onchange={(v) => contrastLevel.set(v as ContrastLevel)}
			/>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Text size</span>
				<span class="ua-hint">{textHint}</span>
			</div>
			<SegmentedControl
				options={TEXT_OPTIONS}
				value={$textScale}
				label="Text size"
				onchange={(v) => textScale.set(v as TextScale)}
			/>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Sound</span>
				<span class="ua-hint">{soundHint}</span>
			</div>
			<SegmentedControl
				options={SOUND_OPTIONS}
				value={$soundCues ? 'on' : 'off'}
				label="Sound"
				onchange={setSound}
			/>
		</div>

		<div class="ua-row">
			<div class="ua-text">
				<span class="ua-title">Reduce transparency</span>
				<span class="ua-hint">Solid panels instead of glass and blur effects</span>
			</div>
			<SegmentedControl
				options={TRANSPARENCY_OPTIONS}
				value={$reduceTransparency ? 'on' : 'off'}
				label="Reduce transparency"
				onchange={(v) => reduceTransparency.set(v === 'on')}
			/>
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
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.ua-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.ua-title {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}

	.ua-hint {
		font-size: var(--text-footnote);
		line-height: 1.4;
		color: var(--text-muted);
	}

	:global(.ui-seg-btn.ua-a0) {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	:global(.ui-seg-btn.ua-a1) {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}

	:global(.ui-seg-btn.ua-a2) {
		font-size: var(--text-body);
		line-height: var(--lh-body);
	}

	:global(.ui-seg-btn.ua-a3) {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
	}
</style>
