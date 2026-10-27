import { untrack } from 'svelte';
import { physics, SPRINGS } from '$lib/design/springs';
import { motionLevel, springTiming } from '$lib/utils/motion.svelte';

export function slidingIndicator(getActive: () => HTMLElement | null | undefined) {
	return (indicator: HTMLElement) => {
		const track = indicator.parentElement;
		if (!track) return;
		let settled = false;

		const place = () => {
			const el = getActive();
			if (!el) {
				indicator.style.opacity = '0';
				return;
			}
			indicator.style.opacity = '1';
			indicator.style.width = `${el.offsetWidth}px`;
			indicator.style.height = `${el.offsetHeight}px`;
			indicator.style.transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
			if (!settled) {
				requestAnimationFrame(() => {
					settled = true;
					indicator.dataset.ready = 'true';
				});
			}
		};

		$effect(() => {
			getActive();
			place();
		});

		const ro = new ResizeObserver(place);
		ro.observe(track);
		return () => ro.disconnect();
	};
}

const STRETCH_VELOCITY = 600;
const STRETCH_CAP = 0.4;
const STRETCH_GAIN = 0.36;
const REST_DISTANCE = 0.05;
const REST_VELOCITY = 2;
const MAX_STEP = 1 / 30;
const SUBSTEPS = 4;

export function stretchIndicator(getActive: () => HTMLElement | null | undefined) {
	return (indicator: HTMLElement) => {
		const track = indicator.parentElement;
		if (!track) return;
		let spring = physics(SPRINGS.glide);
		let x = 0;
		let vx = 0;
		let w = 0;
		let vw = 0;
		let tx = 0;
		let tw = 0;
		let y = 0;
		let placed = false;
		let frame = 0;
		let last = 0;

		const paint = () => {
			const stretch = 1 + Math.min(STRETCH_CAP, Math.abs(vx) / STRETCH_VELOCITY) * STRETCH_GAIN;
			const centre = x + w / 2;
			indicator.style.transform = `translate(${centre - tw / 2}px, ${y}px) scale(${(w * stretch) / tw}, ${1 / stretch})`;
		};

		const jump = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			x = tx;
			w = tw;
			vx = 0;
			vw = 0;
			paint();
		};

		const tick = (now: number) => {
			const dt = Math.min(MAX_STEP, (now - last) / 1000) / SUBSTEPS;
			last = now;
			for (let i = 0; i < SUBSTEPS; i++) {
				vx += (-spring.stiffness * (x - tx) - spring.damping * vx) * dt;
				x += vx * dt;
				vw += (-spring.stiffness * (w - tw) - spring.damping * vw) * dt;
				w += vw * dt;
			}
			const rest =
				Math.abs(x - tx) < REST_DISTANCE &&
				Math.abs(w - tw) < REST_DISTANCE &&
				Math.abs(vx) < REST_VELOCITY &&
				Math.abs(vw) < REST_VELOCITY;
			if (rest) return jump();
			paint();
			frame = requestAnimationFrame(tick);
		};

		const place = (animated: boolean) => {
			const el = getActive();
			if (!el || el.offsetWidth === 0) {
				if (!el) indicator.style.opacity = '0';
				placed = false;
				return;
			}
			indicator.style.opacity = '1';
			tx = el.offsetLeft;
			tw = el.offsetWidth;
			y = el.offsetTop;
			indicator.style.width = `${tw}px`;
			indicator.style.height = `${el.offsetHeight}px`;
			const level = motionLevel();
			if (!placed || !animated || level === 'off') {
				placed = true;
				return jump();
			}
			if (level === 'reduced') {
				jump();
				indicator.animate([{ opacity: 0 }, { opacity: 1 }], springTiming('glide'));
				return;
			}
			spring = physics(SPRINGS.glide);
			if (frame) return;
			last = performance.now();
			frame = requestAnimationFrame(tick);
		};

		$effect(() => {
			getActive();
			untrack(() => place(true));
		});

		const ro = new ResizeObserver(() => place(false));
		ro.observe(track);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	};
}
