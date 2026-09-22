const RAMP = 48;

function paint(el: HTMLElement) {
	const max = el.scrollHeight - el.clientHeight;
	const top = Math.min(el.scrollTop / RAMP, 1);
	const bottom = Math.min(Math.max(max - el.scrollTop, 0) / RAMP, 1);
	el.style.setProperty('--fade-top', top.toFixed(3));
	el.style.setProperty('--fade-bottom', bottom.toFixed(3));
}

export function scrollFade(selector?: string) {
	return (node: Element) => {
		const root = node as HTMLElement;
		let frame = 0;
		const observed = new Set<HTMLElement>();
		const resize = new ResizeObserver(() => schedule());

		function targets(): HTMLElement[] {
			return selector ? Array.from(root.querySelectorAll<HTMLElement>(selector)) : [root];
		}

		function measure() {
			frame = 0;
			const live = targets();
			for (const el of live) {
				if (!observed.has(el)) {
					observed.add(el);
					resize.observe(el);
				}
				paint(el);
			}
			for (const el of observed) {
				if (live.includes(el)) continue;
				observed.delete(el);
				resize.unobserve(el);
			}
		}

		function schedule() {
			if (frame) return;
			frame = requestAnimationFrame(measure);
		}

		measure();
		root.addEventListener('scroll', schedule, { capture: true, passive: true });
		const mutate = new MutationObserver(schedule);
		mutate.observe(root, { childList: true, subtree: true, characterData: true });

		return () => {
			if (frame) cancelAnimationFrame(frame);
			root.removeEventListener('scroll', schedule, { capture: true });
			resize.disconnect();
			mutate.disconnect();
		};
	};
}
