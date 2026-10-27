import { untrack } from 'svelte';
import { decorativeMotion } from '$lib/utils/motion.svelte';

export const SPARK_SLACK = 3;

const SWEEP: KeyframeAnimationOptions = {
	duration: 600,
	easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
};
const SWEEP_FILL_DELAY = 120;

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
	pane.animate([{ transform: 'translateX(-100%)' }, { transform: 'none' }], SWEEP);
	pane
		.querySelector('[data-art]')
		?.animate(
			[{ transform: `translateX(calc(100% + ${SPARK_SLACK * 2}px))` }, { transform: 'none' }],
			SWEEP
		);
	pane.querySelector('[data-fill]')?.animate([{ opacity: 0 }, { opacity: 1 }], {
		...SWEEP,
		delay: SWEEP_FILL_DELAY,
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
			running = (el as HTMLElement).animate(SHIVER_FRAMES, { duration: SHIVER_MS });
		});
		return () => running?.cancel();
	};
}
