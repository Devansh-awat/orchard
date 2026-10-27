import { untrack } from 'svelte';
import { tempo } from '$lib/design/springs';
import { EASE, motionLevel, springTiming } from '$lib/utils/motion.svelte';

const SWEEP_MS = 600;
const SWEEP_STRIDE_MS = 40;

function fade(el: HTMLElement) {
	el.animate([{ opacity: 0 }, { opacity: 1 }], { ...springTiming('glide'), fill: 'backwards' });
}

export function sweepIn(bar: HTMLElement) {
	untrack(() => {
		const level = motionLevel();
		if (level === 'off') return;
		const segs = [...bar.children] as HTMLElement[];
		const scale = tempo();
		segs.forEach((seg, i) => {
			if (level === 'reduced') return fade(seg);
			seg.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
				duration: SWEEP_MS * scale,
				easing: EASE.out,
				delay: i * SWEEP_STRIDE_MS * scale,
				fill: 'backwards'
			});
		});
	});
}

function rise(el: HTMLElement) {
	const level = motionLevel();
	if (level === 'off') return;
	if (level === 'reduced') return fade(el);
	el.animate(
		[
			{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(45%) scale(.86)' },
			{ opacity: 1, filter: 'blur(0)', transform: 'none' }
		],
		springTiming('pop')
	);
}

export function blurRiseList() {
	let armed = false;
	$effect(() => {
		const id = requestAnimationFrame(() => (armed = true));
		return () => cancelAnimationFrame(id);
	});
	return (held: () => boolean = () => false) =>
		(node: Element) => {
			const el = node as HTMLElement;
			let wasHeld = untrack(held);
			if (armed && !wasHeld) rise(el);
			$effect(() => {
				const now = held();
				if (wasHeld && !now) untrack(() => rise(el));
				wasHeld = now;
			});
		};
}

const GLIDE = 'glide';

export function glideX(el: HTMLElement, x: number, jump: boolean) {
	const to = `translateX(${x}px)`;
	const from = getComputedStyle(el).transform;
	for (const a of el.getAnimations()) if (a.id === GLIDE) a.cancel();
	el.style.transform = to;
	if (jump || from === 'none' || motionLevel() !== 'full') return;
	const anim = el.animate([{ transform: from }, { transform: to }], springTiming('glide'));
	anim.id = GLIDE;
}
