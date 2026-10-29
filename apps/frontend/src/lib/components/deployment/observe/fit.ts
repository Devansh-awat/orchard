export function fitViewport(opts: { min: number; gap?: number; prop?: string }) {
	return (node: Element) => {
		const el = node as HTMLElement;
		const gap = opts.gap ?? 24;
		const prop = opts.prop ?? '--fit-h';
		const scroller = el.closest<HTMLElement>('main') ?? document.documentElement;
		let frame = 0;
		const measure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const box = scroller.getBoundingClientRect();
				const top = el.getBoundingClientRect().top - box.top + scroller.scrollTop;
				const next = `${Math.max(opts.min, Math.floor(scroller.clientHeight - top - gap))}px`;
				if (el.style.getPropertyValue(prop) !== next) el.style.setProperty(prop, next);
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
		window.addEventListener('resize', measure);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener('resize', measure);
		};
	};
}
