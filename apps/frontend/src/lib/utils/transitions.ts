import {
	fade as fadeBase,
	fly as flyBase,
	scale as scaleBase,
	slide as slideBase
} from 'svelte/transition';
import type { FadeParams, FlyParams, ScaleParams, SlideParams } from 'svelte/transition';
import { effectiveAnimationLevel } from '$lib/stores/preferences';

type AnyParams = { duration?: number; delay?: number };

function instant<P extends AnyParams>(params?: P): P {
	return { ...params, duration: 0, delay: 0 } as P;
}

export function fade(node: Element, params?: FadeParams) {
	if (effectiveAnimationLevel() === 'off') return fadeBase(node, instant(params));
	return fadeBase(node, params);
}

export function fly(node: Element, params?: FlyParams) {
	const level = effectiveAnimationLevel();
	if (level === 'off') return flyBase(node, instant(params));
	if (level === 'reduced') return flyBase(node, { ...params, x: 0, y: 0 });
	return flyBase(node, params);
}

export function scale(node: Element, params?: ScaleParams) {
	const level = effectiveAnimationLevel();
	if (level === 'off') return scaleBase(node, instant(params));
	if (level === 'reduced') return scaleBase(node, { ...params, start: 1 });
	return scaleBase(node, params);
}

export function slide(node: Element, params?: SlideParams) {
	if (effectiveAnimationLevel() !== 'full') return slideBase(node, instant(params));
	return slideBase(node, params);
}
