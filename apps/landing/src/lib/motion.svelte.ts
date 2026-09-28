import { animate, inView } from 'motion';
import { browser } from '$app/environment';

export type SpringName = 'smooth' | 'snappy' | 'bouncy' | 'interactive' | 'cinematic';

const SPRINGS: Record<SpringName, { visualDuration: number; bounce: number }> = {
	smooth: { visualDuration: 0.26, bounce: 0.2 },
	snappy: { visualDuration: 0.19, bounce: 0.25 },
	bouncy: { visualDuration: 0.28, bounce: 0.45 },
	interactive: { visualDuration: 0.1, bounce: 0.2 },
	cinematic: { visualDuration: 0.8, bounce: 0.14 }
};

const STRIDE = 0.025;
const MAX_STAGGER = 0.2;

export function prefersReduced(): boolean {
	return browser && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function transition(
	name: SpringName = 'snappy',
	opts: { exit?: boolean; delay?: number } = {}
) {
	if (prefersReduced()) return { duration: 0.26, ease: 'linear' as const, delay: 0 };
	const spring = SPRINGS[name];
	return {
		type: 'spring' as const,
		visualDuration: opts.exit ? spring.visualDuration * 0.8 : spring.visualDuration,
		bounce: opts.exit ? spring.bounce + 0.15 : spring.bounce,
		delay: opts.delay ?? 0
	};
}

export function pause(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
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
			{ margin: '0px 0px -8% 0px', amount: 'some' }
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

export function whileVisible(
	el: Element,
	start: () => void,
	stop: () => void,
	opts: { margin?: `${number}px` } = {}
) {
	let visible = false;
	const sync = () => {
		const run = visible && !document.hidden;
		if (run) start();
		else stop();
	};
	const io = new IntersectionObserver(
		(entries) => {
			visible = entries.some((e) => e.isIntersecting);
			sync();
		},
		{ rootMargin: opts.margin ?? '0px' }
	);
	io.observe(el);
	document.addEventListener('visibilitychange', sync);
	return () => {
		io.disconnect();
		document.removeEventListener('visibilitychange', sync);
		stop();
	};
}

export function film(
	el: Element,
	script: (signal: AbortSignal) => Promise<void>,
	opts: { margin?: `${number}px` } = {}
) {
	let ctrl: AbortController | null = null;
	const start = () => {
		if (ctrl) return;
		const current = new AbortController();
		ctrl = current;
		(async () => {
			while (!current.signal.aborted) await script(current.signal);
		})().catch(() => {});
	};
	const stop = () => {
		ctrl?.abort(new DOMException('hidden', 'AbortError'));
		ctrl = null;
	};
	return whileVisible(el, start, stop, opts);
}

export async function typeText(
	text: string,
	write: (value: string) => void,
	signal: AbortSignal,
	perChar = 26
) {
	for (let i = 1; i <= text.length; i++) {
		write(text.slice(0, i));
		await pause(text[i - 1] === ' ' ? perChar * 0.5 : perChar, signal);
	}
}
