import { animate, inView } from 'motion';
import { browser } from '$app/environment';

type SpringName = 'smooth' | 'snappy' | 'bouncy' | 'interactive';

const SPRINGS: Record<SpringName, { visualDuration: number; bounce: number }> = {
	smooth: { visualDuration: 0.26, bounce: 0.2 },
	snappy: { visualDuration: 0.19, bounce: 0.25 },
	bouncy: { visualDuration: 0.28, bounce: 0.45 },
	interactive: { visualDuration: 0.1, bounce: 0.2 }
};

const STRIDE = 0.025;
const MAX_STAGGER = 0.2;

export function prefersReduced(): boolean {
	return browser && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function transition(name: SpringName = 'snappy', opts: { exit?: boolean } = {}) {
	if (prefersReduced()) return { duration: 0.26, ease: 'linear' as const };
	const spring = SPRINGS[name];
	return {
		type: 'spring' as const,
		visualDuration: opts.exit ? spring.visualDuration * 0.8 : spring.visualDuration,
		bounce: opts.exit ? spring.bounce + 0.15 : spring.bounce
	};
}

function staggerDelay(index: number): number {
	return prefersReduced() ? 0 : Math.min(index * STRIDE, MAX_STAGGER);
}

export function reveal(opts: { index?: number; y?: number; spring?: SpringName } = {}) {
	const index = opts.index ?? 0;
	const y = opts.y ?? 14;
	const spring = opts.spring ?? 'smooth';
	return (el: Element) => {
		const target = el as HTMLElement;
		target.classList.add('motion-hidden');
		const keyframes = prefersReduced() ? { opacity: [0, 1] } : { opacity: [0, 1], y: [y, 0] };
		return inView(
			target,
			() => {
				animate(target, keyframes, {
					...transition(spring),
					delay: staggerDelay(index)
				}).finished.then(() => target.classList.remove('motion-hidden'));
			},
			{ amount: 0.2 }
		);
	};
}

export function hover(opts: { lift?: number } = {}) {
	const lift = opts.lift ?? -2;
	return (el: Element) => {
		if (prefersReduced()) return;
		const target = el as HTMLElement;
		const enter = () => animate(target, { y: lift }, transition('snappy'));
		const leave = () => animate(target, { y: 0, scale: 1 }, transition('snappy', { exit: true }));
		const press = () => animate(target, { scale: 0.97 }, transition('interactive'));
		const release = () => animate(target, { scale: 1 }, transition('interactive'));
		target.addEventListener('mouseenter', enter);
		target.addEventListener('mouseleave', leave);
		target.addEventListener('pointerdown', press);
		target.addEventListener('pointerup', release);
		return () => {
			target.removeEventListener('mouseenter', enter);
			target.removeEventListener('mouseleave', leave);
			target.removeEventListener('pointerdown', press);
			target.removeEventListener('pointerup', release);
		};
	};
}
