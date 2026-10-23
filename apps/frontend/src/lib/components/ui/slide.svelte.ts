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
