import type { Placement } from './placement';
import type { Attachment } from 'svelte/attachments';

export class PlacementLock {
	locked = $state<Placement | null>(null);
	#base: () => Placement;
	#open: () => boolean;

	constructor(base: () => Placement, open: () => boolean) {
		this.#base = base;
		this.#open = open;
	}

	config = () => ({
		computePosition: { placement: this.locked ?? this.#base() },
		offset: { mainAxis: 6 },
		shift: { padding: 12 },
		flip: this.locked ? { mainAxis: false, crossAxis: false } : {}
	});

	attach: Attachment<HTMLElement> = (el) => {
		if (!this.#open()) {
			this.locked = null;
			return;
		}
		delete el.dataset.side;
		let done = false;
		const read = () => {
			const side = el.dataset.side;
			if (done || !side) return;
			done = true;
			const align = el.dataset.align;
			this.locked = (align && align !== 'center' ? `${side}-${align}` : side) as Placement;
		};
		const observer = new MutationObserver(read);
		observer.observe(el, { attributes: true, attributeFilter: ['data-side'] });
		return () => observer.disconnect();
	};
}
