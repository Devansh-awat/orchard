import {
  fade as fadeBase,
  fly as flyBase,
  scale as scaleBase,
  slide as slideBase
} from 'svelte/transition';
import type { FadeParams, FlyParams, ScaleParams, SlideParams } from 'svelte/transition';
import { effectiveAnimationLevel } from '@orchardlabs/graft-ui/stores/preferences';

/** Matches REDUCED_DURATION in `$lib/utils/motion.svelte`, in milliseconds. */
const REDUCED_DURATION = 260;

type AnyParams = { duration?: number; delay?: number };

function instant<P extends AnyParams>(params?: P): P {
  return { ...params, duration: 0, delay: 0 } as P;
}

function quick<P extends AnyParams>(params?: P): P {
  return { ...params, duration: REDUCED_DURATION, delay: 0 } as P;
}

export function fade(node: Element, params?: FadeParams) {
  const level = effectiveAnimationLevel();
  if (level === 'off') return fadeBase(node, instant(params));
  if (level === 'reduced') return fadeBase(node, quick(params));
  return fadeBase(node, params);
}

export function fly(node: Element, params?: FlyParams) {
  const level = effectiveAnimationLevel();
  if (level === 'off') return flyBase(node, instant(params));
  if (level === 'reduced') return flyBase(node, quick({ ...params, x: 0, y: 0 }));
  return flyBase(node, params);
}

export function scale(node: Element, params?: ScaleParams) {
  const level = effectiveAnimationLevel();
  if (level === 'off') return scaleBase(node, instant(params));
  if (level === 'reduced') return scaleBase(node, quick({ ...params, start: 1 }));
  return scaleBase(node, params);
}

export function slide(node: Element, params?: SlideParams) {
  const level = effectiveAnimationLevel();
  if (level === 'off') return slideBase(node, instant(params));
  if (level === 'reduced') return slideBase(node, quick(params));
  return slideBase(node, params);
}
