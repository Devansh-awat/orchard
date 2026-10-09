import { play, sounds, type SoundName } from 'cuelume';
import { get } from 'svelte/store';
import { browser } from '$app/environment';
import { soundCues } from '$lib/stores/preferences';
import { CueGate } from '$lib/utils/sound-cues';
import { greenhousePrefs, type SoundChoice, type SoundEvent } from './prefs.svelte';

const gate = new CueGate();

export const SOUND_NAMES: readonly SoundName[] = sounds;

export function soundLabel(choice: SoundChoice): string {
	if (choice === 'none') return 'Off';
	return choice.charAt(0).toUpperCase() + choice.slice(1);
}

function audible(choice: SoundChoice): choice is SoundName {
	return choice !== 'none' && (SOUND_NAMES as readonly string[]).includes(choice);
}

export function soundsOn(): boolean {
	return browser && get(soundCues);
}

export function playGreenhouseSound(event: SoundEvent) {
	if (!soundsOn()) return;
	const choice = greenhousePrefs.values.sounds[event];
	if (!audible(choice)) return;
	if (!gate.allow(event, Date.now())) return;
	play(choice);
}

export function previewSound(choice: SoundChoice) {
	if (!soundsOn() || !audible(choice)) return;
	play(choice);
}
