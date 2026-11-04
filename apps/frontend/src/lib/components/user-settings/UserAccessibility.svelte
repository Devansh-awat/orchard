<script lang="ts">
	import {
		SectionCard,
		SegmentedControl,
		SettingRow,
		SettingsList,
		ToggleRow
	} from '$lib/components/ui';
	import {
		animationLevel,
		contrastLevel,
		textScale,
		reduceTransparency,
		soundCues,
		type AnimationLevel,
		type TextScale
	} from '$lib/stores';
	import { previewCue } from '$lib/utils/sound';

	let { index: _index = 0 }: { index?: number } = $props();

	const ANIMATION_OPTIONS: { value: AnimationLevel; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows your system reduced motion setting' },
		{ value: 'full', label: 'Full', hint: 'All animations and hover effects' },
		{ value: 'reduced', label: 'Reduced', hint: 'Fades only. Nothing slides or scales.' },
		{ value: 'off', label: 'Off', hint: 'Nothing animates, including background gradients' }
	];

	const TEXT_OPTIONS: { value: TextScale; label: string; hint: string }[] = [
		{ value: 'sm', label: 'Small', hint: 'Smaller text and interface' },
		{ value: 'md', label: 'Default', hint: 'Default size' },
		{ value: 'lg', label: 'Large', hint: 'Larger text and interface' },
		{ value: 'xl', label: 'Largest', hint: 'Largest text and interface' }
	];

	const animationHint = $derived(
		ANIMATION_OPTIONS.find((o) => o.value === $animationLevel)?.hint ?? ''
	);
	const textHint = $derived(TEXT_OPTIONS.find((o) => o.value === $textScale)?.hint ?? '');

	function setSound(on: boolean) {
		soundCues.set(on);
		if (on) previewCue();
	}
</script>

<SectionCard title="Motion and sound">
	<SettingsList>
		<SettingRow label="Animation" hint={animationHint}>
			<SegmentedControl
				options={ANIMATION_OPTIONS}
				value={$animationLevel}
				label="Animation"
				onchange={(v) => animationLevel.set(v as AnimationLevel)}
			/>
		</SettingRow>
		<ToggleRow
			label="Sound"
			hint="A cue when a build you are waiting on finishes"
			bind:checked={() => $soundCues, setSound}
		/>
	</SettingsList>
</SectionCard>

<SectionCard title="Display">
	<SettingsList>
		<SettingRow label="Text size" hint={textHint}>
			<SegmentedControl
				options={TEXT_OPTIONS}
				value={$textScale}
				label="Text size"
				onchange={(v) => textScale.set(v as TextScale)}
			/>
		</SettingRow>
		<ToggleRow
			label="Increase contrast"
			hint="Darker text and visible borders"
			bind:checked={
				() => $contrastLevel === 'high', (on) => contrastLevel.set(on ? 'high' : 'default')
			}
		/>
		<ToggleRow
			label="Reduce transparency"
			hint="Solid panels instead of glass and blur"
			bind:checked={() => $reduceTransparency, (on) => reduceTransparency.set(on)}
		/>
	</SettingsList>
</SectionCard>
