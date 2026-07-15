import {
	fade as fadeBase,
	fly as flyBase,
	scale as scaleBase,
	slide as slideBase
} from 'svelte/transition';
import type { FadeParams, FlyParams, ScaleParams, SlideParams } from 'svelte/transition';
import { functionalMotion } from '$lib/utils/motion.svelte';

function gated<P extends { duration?: number; delay?: number }>(
	fn: (node: Element, params?: P) => ReturnType<typeof fadeBase>
) {
	return (node: Element, params?: P) =>
		functionalMotion() ? fn(node, params) : fn(node, { ...params, duration: 0, delay: 0 } as P);
}

export const fade = gated<FadeParams>(fadeBase);
export const fly = gated<FlyParams>(flyBase);
export const scale = gated<ScaleParams>(scaleBase);
export const slide = gated<SlideParams>(slideBase);
