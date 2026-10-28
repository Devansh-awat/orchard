import {
	fade as fadeBase,
	fly as flyBase,
	scale as scaleBase,
	slide as slideBase
} from 'svelte/transition';
import type {
	FadeParams,
	FlyParams,
	ScaleParams,
	SlideParams,
	TransitionConfig
} from 'svelte/transition';
import { cubicInOut } from 'svelte/easing';
import { effectiveAnimationLevel } from '$lib/stores/preferences';
import { springProgress } from '$lib/utils/motion.svelte';

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

const PRESENCE_LAG = 50;
const PRESENCE_RISE = 4;
const PRESENCE_SHRINK = 0.98;
const SWAP_RISE = 6;

type Direction = { direction?: 'in' | 'out' | 'both' };

function stackGap(el: HTMLElement) {
	const parent = el.parentElement;
	if (!parent) return 0;
	const ps = getComputedStyle(parent);
	if (!ps.display.includes('flex') || !ps.flexDirection.startsWith('column')) return 0;
	if (!el.previousElementSibling && !el.nextElementSibling) return 0;
	return parseFloat(ps.rowGap) || 0;
}

function spaceOf(el: HTMLElement) {
	const visibility = el.style.contentVisibility;
	el.style.contentVisibility = 'visible';
	const style = getComputedStyle(el);
	const height = parseFloat(style.height) || 0;
	const sides = ['padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width'].map(
		(p) => [p, parseFloat(style.getPropertyValue(p)) || 0] as const
	);
	const gap = stackGap(el);
	const edge = el.previousElementSibling ? 'margin-top' : 'margin-bottom';
	const margin = parseFloat(style.getPropertyValue(edge)) || 0;
	const opacity = parseFloat(style.opacity);
	el.style.contentVisibility = visibility;
	return {
		height,
		opacity: Number.isNaN(opacity) ? 1 : opacity,
		at: (k: number) =>
			[
				'overflow: hidden',
				'min-height: 0',
				'content-visibility: visible',
				`height: ${height * k}px`,
				...sides.map(([p, v]) => `${p}: ${v * k}px`),
				`${edge}: ${-gap + (margin + gap) * k}px`
			].join('; ')
	};
}

export function presence(
	node: Element,
	params: { enabled?: boolean; fade?: boolean } = {},
	options: Direction = {}
): TransitionConfig {
	const level = effectiveAnimationLevel();
	if (params.enabled === false || level === 'off') return { duration: 0 };
	const space = spaceOf(node as HTMLElement);
	const entering = options.direction !== 'out';
	if (params.fade === false) {
		const shape = entering
			? springProgress('glide', { distance: space.height })
			: springProgress('settle', { exit: true, distance: space.height });
		return level === 'reduced'
			? { duration: REDUCED_DURATION, easing: cubicInOut, css: (t) => space.at(t) }
			: {
					duration: shape.duration,
					css: (t) => {
						const s = shape.at((entering ? t : 1 - t) * shape.duration);
						return space.at(Math.max(0, entering ? s : 1 - s));
					}
				};
	}
	if (level === 'reduced') {
		return {
			duration: REDUCED_DURATION,
			easing: cubicInOut,
			css: (t) => `${space.at(t)}; opacity: ${t * space.opacity}`
		};
	}
	const shape = entering
		? springProgress('glide', { distance: space.height })
		: springProgress('settle', { exit: true, distance: space.height });
	const content = entering ? springProgress('pop') : springProgress('settle', { exit: true });
	const shapeLag = entering ? 0 : PRESENCE_LAG;
	const contentLag = entering ? PRESENCE_LAG : 0;
	const total = Math.max(shape.duration + shapeLag, content.duration + contentLag);
	return {
		duration: total,
		css: (t) => {
			const ms = (entering ? t : 1 - t) * total;
			const s = shape.at(ms - shapeLag);
			const c = content.at(ms - contentLag);
			const k = Math.max(0, entering ? s : 1 - s);
			const shown = Math.min(1, Math.max(0, entering ? c : 1 - c));
			const rise = entering ? (1 - c) * -PRESENCE_RISE : 0;
			const size = PRESENCE_SHRINK + (1 - PRESENCE_SHRINK) * (entering ? c : 1 - c);
			return `${space.at(k)}; opacity: ${shown * space.opacity}; transform: translateY(${rise}px) scale(${size})`;
		}
	};
}

export function swap(node: Element, params: { enabled?: boolean } = {}): TransitionConfig {
	const level = effectiveAnimationLevel();
	if (params.enabled === false || level === 'off') return { duration: 0 };
	if (level === 'reduced') {
		return { duration: REDUCED_DURATION, easing: cubicInOut, css: (t) => `opacity: ${t}` };
	}
	const glide = springProgress('glide');
	return {
		duration: glide.duration,
		css: (t) => {
			const p = glide.at(t * glide.duration);
			return `opacity: ${Math.min(1, Math.max(0, p))}; transform: translateY(${(1 - p) * SWAP_RISE}px)`;
		}
	};
}
