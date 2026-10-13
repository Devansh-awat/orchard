import { play, setEnabled } from 'cuelume';
import { get } from 'svelte/store';
import { browser } from '../../host/environment';
import { soundCues } from '@orchard/graft-ui/stores/preferences';
import { CueGate, cueForBuildEvent, type Cue } from './sound-cues';

const gate = new CueGate();
let focusedDeploymentId: string | null = null;
const watched = new Set<string>();

if (browser) {
  soundCues.subscribe((on) => setEnabled(on));
}

export function focusDeployment(id: string | null) {
  focusedDeploymentId = id;
}

export function watchBuild(deploymentId: string) {
  watched.add(deploymentId);
}

export function cue(name: Cue, opts: { volume?: number } = {}) {
  if (!browser || !get(soundCues)) return;
  if (!gate.allow(name, Date.now())) return;
  play(name, opts);
}

export function previewCue() {
  if (!browser) return;
  play('success', { volume: 0.6 });
}

export function cueForEvent(ev: {
  type: string;
  id?: string;
  payload?: { buildStatus?: unknown } | null;
}) {
  const name = cueForBuildEvent(ev, { focusedDeploymentId, watched });
  if (!name) return;
  if (ev.id) watched.delete(ev.id);
  cue(name);
}
