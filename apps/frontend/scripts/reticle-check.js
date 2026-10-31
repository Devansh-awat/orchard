(() => {
	const TOLERANCE = 1.5;
	const canvas = document.createElement('canvas').getContext('2d');
	const scale =
		parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--corner-scale')) || 1;

	function radiusOf(el) {
		const r = parseFloat(getComputedStyle(el).borderTopRightRadius) || 0;
		return r >= 999 ? r : r / scale;
	}

	function visible(el) {
		const s = getComputedStyle(el);
		return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0;
	}

	function isSurface(el) {
		if (!(el instanceof HTMLElement) || !visible(el)) return false;
		if (el.matches('button, a, input, textarea, select, img, svg, [role=switch], .ui-badge'))
			return false;
		const s = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		if (r.width < 160 || r.height < 56) return false;
		if (r.bottom < 0 || r.top > innerHeight) return false;
		if ((parseFloat(s.borderTopLeftRadius) || 0) / scale < 12) return false;
		const bg = s.backgroundColor;
		const filled = bg && !bg.endsWith(', 0)') && bg !== 'transparent';
		return filled || (s.boxShadow && s.boxShadow !== 'none');
	}

	function capBox(node) {
		const host = node.parentElement;
		const s = getComputedStyle(host);
		const range = document.createRange();
		range.selectNodeContents(node);
		const rect = range.getClientRects()[0];
		if (!rect) return null;
		if (s.textBoxTrim && s.textBoxTrim !== 'none') {
			const hr = host.getBoundingClientRect();
			return { top: hr.top, left: rect.left };
		}
		canvas.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
		const m = canvas.measureText('H');
		return {
			top: rect.top + (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent),
			left: rect.left
		};
	}

	function filled(el) {
		const s = getComputedStyle(el);
		const bg = s.backgroundColor;
		return (
			(bg && !bg.endsWith(', 0)') && bg !== 'transparent') ||
			(s.boxShadow && s.boxShadow !== 'none')
		);
	}

	function boxOf(el, box, label) {
		let e = el;
		while (e && e !== box) {
			if (
				e instanceof HTMLElement &&
				filled(e) &&
				e.getBoundingClientRect().width < box.getBoundingClientRect().width * 0.8
			) {
				const r = e.getBoundingClientRect();
				return { top: r.top, left: r.left, label: `[${label}]` };
			}
			e = e.parentElement;
		}
		return null;
	}

	function firstContent(box) {
		const walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			if (node.nodeType === Node.TEXT_NODE) {
				if (node.textContent.trim() && visible(node.parentElement)) {
					const control = node.parentElement.closest('button, a, [role=tab], [role=switch]');
					if (control && box.contains(control) && filled(control)) {
						const cr = control.getBoundingClientRect();
						return {
							top: cr.top,
							left: cr.left,
							label: `[${node.textContent.trim().slice(0, 20)}]`
						};
					}
					const c = capBox(node);
					if (c)
						return { ...c, el: node.parentElement, label: node.textContent.trim().slice(0, 24) };
				}
			} else if (node !== box) {
				const el = node;
				if (
					!visible(el) ||
					(el.getAttribute('aria-hidden') === 'true' && !el.matches('svg, img'))
				) {
					node = walker.nextSibling() ?? walker.nextNode();
					continue;
				}
				if (isSurface(el)) {
					node = walker.nextSibling() ?? walker.nextNode();
					continue;
				}
				if (el.matches('svg, img, canvas, video, .ui-tone-tile, [role=img]')) {
					const control = el.closest('button, a, [role=tab], [role=switch]');
					if (control && box.contains(control) && filled(control)) {
						const cr = control.getBoundingClientRect();
						return { top: cr.top, left: cr.left, label: '[control]' };
					}
					if (inBleedRow(el, box)) return { el };
					const capsule = boxOf(el, box, el.tagName.toLowerCase());
					if (capsule) return capsule;
					const r = el.getBoundingClientRect();
					if (r.width > 0)
						return { top: r.top, left: r.left, label: `<${el.tagName.toLowerCase()}>` };
				}
			}
			node = walker.nextNode();
		}
		return null;
	}

	const ROW = '[role=listitem], [role=row], tr, .row, li';

	function inBleedRow(el, box) {
		const row = el.closest(ROW);
		if (!row || !box.contains(row) || row === box) return false;
		return row.getBoundingClientRect().width > box.getBoundingClientRect().width * 0.8;
	}

	const out = [];
	const surfaces = [...document.querySelectorAll('body *')].filter(isSurface);
	for (const box of surfaces) {
		const r = box.getBoundingClientRect();
		const name =
			box.getAttribute('aria-label') ||
			`${box.tagName.toLowerCase()}.${[...box.classList]
				.filter((c) => !c.startsWith('svelte-'))
				.slice(0, 2)
				.join('.')}`;
		const pad = Math.max(
			parseFloat(getComputedStyle(box).paddingLeft) || 0,
			parseFloat(getComputedStyle(box).paddingTop) || 0
		);
		const outer = radiusOf(box);

		const first = firstContent(box);
		if (first && !(first.el && inBleedRow(first.el, box))) {
			const top = first.top - r.top;
			const left = first.left - r.left;
			if (top < 48 && left < 48 && Math.abs(top - left) > TOLERANCE)
				out.push({
					where: name,
					rule: 'corner content',
					what: first.label,
					top: +top.toFixed(1),
					left: +left.toFixed(1)
				});
		}

		const controls = [...box.querySelectorAll('button, a[href], [role=switch]')].filter((c) => {
			if (!visible(c)) return false;
			const cr = c.getBoundingClientRect();
			if (cr.width === 0) return false;
			let owner = c.parentElement;
			while (owner && owner !== box && !isSurface(owner)) owner = owner.parentElement;
			return (
				owner === box &&
				cr.top - r.top < Math.max(pad, 16) + 4 &&
				r.right - cr.right < Math.max(pad, 16) + 4
			);
		});
		const clips = ['hidden', 'clip'].includes(getComputedStyle(box).overflowX);
		const grouped = controls
			.map((c) => c.closest('[role=radiogroup], [role=tablist], [role=group], .segmented') ?? c)
			.filter((c) => box.contains(c) && c !== box)
			.filter((c) => !(clips && c.getBoundingClientRect().width > r.width * 0.8))
			.filter((c) => !(clips && inBleedRow(c, box)));
		const corner = grouped.sort(
			(a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right
		)[0];
		if (corner) {
			const cr = corner.getBoundingClientRect();
			const top = cr.top - r.top;
			const right = r.right - cr.right;
			const inner = Math.min(radiusOf(corner), cr.height / 2);
			const want = Math.max(outer - inner, 0);
			if (Math.abs(top - right) > TOLERANCE || (outer > inner && Math.abs(top - want) > TOLERANCE))
				out.push({
					where: name,
					rule: 'corner control',
					what: (corner.getAttribute('aria-label') || corner.textContent).trim().slice(0, 24),
					top: +top.toFixed(1),
					right: +right.toFixed(1),
					concentric: +want.toFixed(1)
				});
		}
	}
	return out.length ? out : 'clean';
})();
