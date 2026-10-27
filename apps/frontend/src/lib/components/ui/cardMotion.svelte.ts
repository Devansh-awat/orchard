import { untrack } from 'svelte';
import { tempo } from '$lib/design/springs';
import { EASE, decorativeMotion } from '$lib/utils/motion.svelte';

export const SPARK_SLACK = 3;

const SWEEP_MS = 600;
const SWEEP_FILL_DELAY_MS = 120;

const SHIVER_AMPLITUDE = 5;
const SHIVER_DECAY_MS = 190;
const SHIVER_HZ = 10;
const SHIVER_MS = 400;
const SAMPLE_MS = 1000 / 120;

const SHIVER_STEPS = Math.round(SHIVER_MS / SAMPLE_MS);

const SHIVER_FRAMES: Keyframe[] = Array.from({ length: SHIVER_STEPS + 1 }, (_, i) => {
	if (i === SHIVER_STEPS) return { translate: '0 0' };
	const t = i * SAMPLE_MS;
	const x =
		SHIVER_AMPLITUDE *
		Math.exp(-t / SHIVER_DECAY_MS) *
		Math.sin((2 * Math.PI * SHIVER_HZ * t) / 1000);
	return { translate: `${x.toFixed(2)}px 0` };
});

export function sparkSweep(pane: HTMLElement) {
	if (!untrack(decorativeMotion)) return;
	const scale = tempo();
	const sweep: KeyframeAnimationOptions = { duration: SWEEP_MS * scale, easing: EASE.out };
	pane.animate([{ transform: 'translateX(-100%)' }, { transform: 'none' }], sweep);
	pane
		.querySelector('[data-art]')
		?.animate(
			[{ transform: `translateX(calc(100% + ${SPARK_SLACK * 2}px))` }, { transform: 'none' }],
			sweep
		);
	pane.querySelector('[data-fill]')?.animate([{ opacity: 0 }, { opacity: 1 }], {
		...sweep,
		delay: SWEEP_FILL_DELAY_MS * scale,
		fill: 'backwards'
	});
}

export function crashShiver(kind: () => string) {
	return (el: Element) => {
		let last = untrack(kind);
		let running: Animation | null = null;
		$effect(() => {
			const next = kind();
			const prev = last;
			last = next;
			if (next !== 'error' || prev === 'error') return;
			if (!untrack(decorativeMotion)) return;
			running?.cancel();
			running = (el as HTMLElement).animate(SHIVER_FRAMES, { duration: SHIVER_MS * tempo() });
		});
		return () => running?.cancel();
	};
}
