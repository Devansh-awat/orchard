type SvelteLoc = { file: string; line: number; column: number };
type SvelteMeta = { loc?: SvelteLoc };

type Pick = {
	loc: SvelteLoc;
	tag: string;
	classes: string;
	text: string;
	chain: string[];
	url: string;
};

const HINT =
	'ui picker: click an element to copy its source. shift+click to add more. esc to cancel.';

function metaOf(node: unknown): SvelteMeta | undefined {
	return (node as { __svelte_meta?: SvelteMeta } | null)?.__svelte_meta;
}

function nearestLocated(el: Element | null): { el: Element; loc: SvelteLoc } | null {
	let cur: Element | null = el;
	while (cur) {
		const loc = metaOf(cur)?.loc;
		if (loc) return { el: cur, loc };
		cur = cur.parentElement;
	}
	return null;
}

function shortFile(file: string): string {
	const i = file.indexOf('src/');
	if (i === -1) return file;
	return `apps/frontend/${file.slice(i)}`;
}

function describe(el: Element): { tag: string; classes: string; text: string } {
	const tag = el.tagName.toLowerCase();
	const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
	const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
	return { tag, classes, text };
}

function chainOf(el: Element): string[] {
	const seen: string[] = [];
	let cur: Element | null = el;
	while (cur && seen.length < 5) {
		const loc = metaOf(cur)?.loc;
		if (loc) {
			const entry = `${shortFile(loc.file).split('/').pop()}:${loc.line}`;
			if (seen[seen.length - 1] !== entry) seen.push(entry);
		}
		cur = cur.parentElement;
	}
	return seen;
}

function format(picks: Pick[]): string {
	return picks
		.map((p, i) => {
			const head = `ui target ${i + 1}: ${shortFile(p.loc.file)}:${p.loc.line}:${p.loc.column}`;
			const el = `  element: <${p.tag}>${p.classes ? ` class="${p.classes}"` : ''}`;
			const text = p.text ? `\n  text: ${JSON.stringify(p.text)}` : '';
			const chain = p.chain.length > 1 ? `\n  inside: ${p.chain.join(' < ')}` : '';
			return `${head}\n${el}${text}${chain}\n  page: ${p.url}`;
		})
		.join('\n\n');
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		return ok;
	}
}

export function mountUiPicker(): () => void {
	let active = false;
	let picks: Pick[] = [];
	let box: HTMLDivElement | null = null;
	let label: HTMLDivElement | null = null;
	let bar: HTMLDivElement | null = null;
	let fade: ReturnType<typeof setTimeout> | null = null;
	const handle = document.createElement('button');

	function chrome() {
		if (box && label && bar) return;
		unchrome();
		box = document.createElement('div');
		box.style.cssText =
			'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #f97316;background:rgba(249,115,22,0.12);border-radius:3px;transition:all 60ms linear;';
		label = document.createElement('div');
		label.style.cssText =
			'position:fixed;pointer-events:none;z-index:2147483647;background:#f97316;color:#fff;font:11px/1.6 ui-monospace,monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;';
		bar = document.createElement('div');
		bar.style.cssText =
			'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);pointer-events:none;z-index:2147483647;background:#18181b;color:#fafafa;font:12px/1.6 ui-monospace,monospace;padding:6px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.35);';
		bar.textContent = HINT;
		document.body.append(box, label, bar);
	}

	function unchrome() {
		if (fade) clearTimeout(fade);
		fade = null;
		box?.remove();
		label?.remove();
		bar?.remove();
		box = null;
		label = null;
		bar = null;
	}

	function paint(el: Element, loc: SvelteLoc) {
		chrome();
		const r = el.getBoundingClientRect();
		if (!box || !label) return;
		box.style.left = `${r.left}px`;
		box.style.top = `${r.top}px`;
		box.style.width = `${r.width}px`;
		box.style.height = `${r.height}px`;
		const name = shortFile(loc.file).split('/').pop();
		label.textContent = `${name}:${loc.line}`;
		const above = r.top > 22;
		label.style.left = `${Math.max(4, r.left)}px`;
		label.style.top = `${above ? r.top - 22 : r.bottom + 4}px`;
	}

	function onMove(e: MouseEvent) {
		if (!active) return;
		const hit = nearestLocated(document.elementFromPoint(e.clientX, e.clientY));
		if (hit) paint(hit.el, hit.loc);
	}

	function swallow(e: Event) {
		if (!active) return;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	async function onClick(e: MouseEvent) {
		if (!active) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		const hit = nearestLocated(document.elementFromPoint(e.clientX, e.clientY));
		if (!hit) return;
		picks.push({
			loc: hit.loc,
			...describe(hit.el),
			chain: chainOf(hit.el),
			url: location.pathname
		});
		if (e.shiftKey) {
			if (bar) bar.textContent = `${picks.length} picked. shift+click for more, click to finish.`;
			return;
		}
		const text = format(picks);
		const ok = await copy(text);
		console.log(`[ui-picker]\n${text}`);
		stop(
			ok
				? `copied ${picks.length} target${picks.length > 1 ? 's' : ''}`
				: 'copy failed, see console'
		);
	}

	function onKey(e: KeyboardEvent) {
		if (e.code === 'Escape' && active) {
			stop(null);
			return;
		}
		if (e.code === 'KeyU' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			toggle();
		}
	}

	function toggle() {
		if (active) stop(null);
		else start();
	}

	function start() {
		active = true;
		picks = [];
		unchrome();
		document.body.style.cursor = 'crosshair';
		handle.style.opacity = '0';
		handle.style.pointerEvents = 'none';
		chrome();
	}

	function stop(message: string | null) {
		active = false;
		document.body.style.cursor = '';
		handle.style.opacity = '';
		handle.style.pointerEvents = '';
		if (message && bar) {
			bar.textContent = message;
			box?.remove();
			label?.remove();
			box = null;
			label = null;
			if (fade) clearTimeout(fade);
			fade = setTimeout(unchrome, 1800);
		} else {
			unchrome();
		}
		picks = [];
	}

	handle.type = 'button';
	handle.textContent = 'pick';
	handle.title = 'pick a ui element (ctrl+shift+u)';
	handle.style.cssText =
		'position:fixed;left:10px;bottom:10px;z-index:2147483645;appearance:none;border:1px solid rgba(249,115,22,0.5);background:rgba(24,24,27,0.72);color:#f97316;font:10px/1 ui-monospace,monospace;letter-spacing:0.04em;padding:5px 7px;border-radius:5px;opacity:0.35;cursor:pointer;transition:opacity 120ms linear;';
	handle.onpointerenter = () => {
		if (!active) handle.style.opacity = '1';
	};
	handle.onpointerleave = () => {
		if (!active) handle.style.opacity = '0.35';
	};
	handle.onclick = (e) => {
		e.stopPropagation();
		if (!active) start();
	};
	document.body.appendChild(handle);
	(window as unknown as { pickUi: () => void }).pickUi = toggle;

	window.addEventListener('mousemove', onMove, true);
	window.addEventListener('mousedown', swallow, true);
	window.addEventListener('pointerdown', swallow, true);
	window.addEventListener('click', onClick, true);
	window.addEventListener('keydown', onKey, true);

	return () => {
		window.removeEventListener('mousemove', onMove, true);
		window.removeEventListener('mousedown', swallow, true);
		window.removeEventListener('pointerdown', swallow, true);
		window.removeEventListener('click', onClick, true);
		window.removeEventListener('keydown', onKey, true);
		handle.remove();
		stop(null);
	};
}
