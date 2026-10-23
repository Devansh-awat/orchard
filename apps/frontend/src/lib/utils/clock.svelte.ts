import { browser } from '$app/environment';

const COARSE_STEP_MS = 15_000;
const FINE_WINDOW_MS = 90_000;

function quantize(t: number): number {
	return t - (t % COARSE_STEP_MS);
}

export const clock = $state({ now: Date.now(), coarse: quantize(Date.now()) });

if (browser) {
	setInterval(() => {
		const t = Date.now();
		clock.now = t;
		clock.coarse = quantize(t);
	}, 1_000);
}

export function elapsedSince(t: number): number {
	const coarseElapsed = clock.coarse - t;
	return coarseElapsed < FINE_WINDOW_MS ? clock.now - t : coarseElapsed;
}
