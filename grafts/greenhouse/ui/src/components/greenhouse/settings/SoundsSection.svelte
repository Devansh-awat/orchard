<script lang="ts">
	import { Play } from '@jis3r/icons';
	import { Select } from '@orchardlabs/graft-ui';
	import IconButton from '../../user-settings/IconButton.svelte';
	import { soundCues } from '@orchardlabs/graft-ui/stores/preferences';
	import { previewCue } from '../../../lib/utils/sound';
	import { greenhousePrefs, type SoundChoice, type SoundEvent } from '../prefs.svelte';
	import { SOUND_NAMES, previewSound, soundLabel } from '../sounds';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	const EVENTS: { id: SoundEvent; title: string; hint: string }[] = [
		{ id: 'done', title: 'Agent finished', hint: 'A session finished its turn' },
		{ id: 'attention', title: 'Needs your attention', hint: 'A permission or a question' },
		{ id: 'error', title: 'Errors', hint: 'A turn failed' }
	];

	const CHOICES: SoundChoice[] = ['none', ...SOUND_NAMES];

	const on = $derived($soundCues);

	function setMaster(next: boolean) {
		soundCues.set(next);
		if (next) previewCue();
	}

	function choose(event: SoundEvent, choice: SoundChoice) {
		greenhousePrefs.setSound(event, choice);
		previewSound(choice);
	}
</script>

<Card>
	<Row
		title="Sounds"
		description="Shared with Orchard, in Accessibility"
		checked={on}
		ontoggle={setMaster}
	/>
</Card>

<Card title="Play a sound when">
	{#each EVENTS as event (event.id)}
		{@const choice = greenhousePrefs.values.sounds[event.id]}
		<Row title={event.title} description={event.hint} disabled={!on}>
			{#snippet control()}
				<div class="pick">
					<Select
						value={choice}
						aria-label="{event.title} sound"
						disabled={!on}
						onchange={(e: Event) =>
							choose(event.id, (e.currentTarget as HTMLSelectElement).value as SoundChoice)}
					>
						{#each CHOICES as option (option)}
							<option value={option}>{soundLabel(option)}</option>
						{/each}
					</Select>
				</div>
				<IconButton
					title="Play {soundLabel(choice)}"
					disabled={!on || choice === 'none'}
					onclick={() => previewSound(choice)}
				>
					{#snippet children(hovered)}
						<span class="glyph" aria-hidden="true"
							><Play size={14} strokeWidth={1.75} animate={hovered} /></span
						>
					{/snippet}
				</IconButton>
			{/snippet}
		</Row>
	{/each}
</Card>

<style>
	.pick {
		width: 9rem;
	}

	.glyph {
		display: inline-grid;
		place-items: center;
		line-height: 0;
		pointer-events: none;
	}
</style>
