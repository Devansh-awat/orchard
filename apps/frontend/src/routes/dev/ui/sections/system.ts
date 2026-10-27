import { decorativeMotion } from '$lib/utils/motion.svelte';

export function offsetX(el: HTMLElement) {
	const t = getComputedStyle(el).transform;
	return !t || t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41;
}

export function slide(el: HTMLElement, x: number, timing: KeyframeAnimationOptions) {
	const from = offsetX(el);
	for (const a of el.getAnimations()) a.cancel();
	const a = `translateX(${from}px)`;
	const b = `translateX(${x}px)`;
	const frames = decorativeMotion()
		? [{ transform: a }, { transform: b }]
		: [
				{ transform: a, opacity: 1 },
				{ transform: a, opacity: 0, offset: 0.5 },
				{ transform: b, opacity: 0, offset: 0.5 },
				{ transform: b, opacity: 1 }
			];
	return el.animate(frames, { ...timing, fill: 'forwards' });
}

export function fadeTo(el: HTMLElement, to: number, timing: KeyframeAnimationOptions) {
	const from = Number(getComputedStyle(el).opacity);
	for (const a of el.getAnimations()) a.cancel();
	return el.animate([{ opacity: from }, { opacity: to }], { ...timing, fill: 'forwards' });
}

export function curvePath(points: number[], w: number, h: number, top = 1.3) {
	const last = points.length - 1;
	return points
		.map(
			(p, i) => `${i ? 'L' : 'M'}${((i / last) * w).toFixed(1)} ${(h - (p / top) * h).toFixed(1)}`
		)
		.join(' ');
}
