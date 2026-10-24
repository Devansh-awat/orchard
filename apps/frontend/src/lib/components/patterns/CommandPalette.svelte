<script lang="ts" module>
	import type { StatusMeta } from '$lib/components/ui/status';
	import type { Icon } from '$lib/components/ui/types';

	export type PaletteItem = {
		id: string;
		label: string;
		sublabel?: string;
		kind: 'project' | 'deployment' | 'database' | 'job';
		icon?: string | null;
		status?: StatusMeta;
		href: string;
		url?: string;
	};

	export type PaletteAction = {
		id: string;
		label: string;
		hint?: string;
		icon: Icon;
		keywords?: string[];
		shortcut?: string;
		run: () => void;
	};

	type Range = [number, number];
	type Seg = { text: string; hit: boolean };

	const warmed = new Set<string>();

	function locate(text: string, q: string): { score: number; ranges: Range[] } | null {
		const t = text.toLowerCase();
		const i = t.indexOf(q);
		if (i === 0) return { score: 0, ranges: [[0, q.length]] };
		if (i > 0) return { score: /[\s\-_./]/.test(t[i - 1]) ? 1 : 2, ranges: [[i, i + q.length]] };
		const needle = q.replace(/\s+/g, '');
		if (needle.length < 2) return null;
		const ranges: Range[] = [];
		let k = 0;
		for (let j = 0; j < t.length && k < needle.length; j++) {
			if (t[j] !== needle[k]) continue;
			const last = ranges[ranges.length - 1];
			if (last && last[1] === j) last[1] = j + 1;
			else ranges.push([j, j + 1]);
			k++;
		}
		if (k < needle.length || ranges.length > Math.max(2, Math.ceil(needle.length / 2))) return null;
		return { score: 3 + ranges.length, ranges };
	}

	function segments(text: string, ranges: Range[]): Seg[] {
		const out: Seg[] = [];
		let at = 0;
		for (const [a, b] of ranges) {
			if (a > at) out.push({ text: text.slice(at, a), hit: false });
			out.push({ text: text.slice(a, b), hit: true });
			at = b;
		}
		if (at < text.length) out.push({ text: text.slice(at), hit: false });
		return out;
	}

	const plain = (text: string): Seg[] => [{ text, hit: false }];

	const KEY_CODES: Record<string, string> = {
		',': 'Comma',
		'.': 'Period',
		'/': 'Slash',
		';': 'Semicolon',
		'[': 'BracketLeft',
		']': 'BracketRight',
		'↵': 'Enter',
		'⌫': 'Backspace'
	};

	function keysOf(shortcut: string): string[] {
		return shortcut.match(/[⌘⇧⌥⌃]|[^⌘⇧⌥⌃]+/g) ?? [];
	}

	function codeOf(key: string): string {
		if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
		if (/^\d$/.test(key)) return `Digit${key}`;
		return KEY_CODES[key] ?? key;
	}

	function pressed(shortcut: string, e: KeyboardEvent): boolean {
		const keys = keysOf(shortcut);
		const main = keys.filter((k) => !'⌘⇧⌥⌃'.includes(k));
		if (main.length !== 1) return false;
		const meta = keys.includes('⌘');
		return (
			(meta ? e.metaKey || e.ctrlKey : !e.metaKey) &&
			e.shiftKey === keys.includes('⇧') &&
			e.altKey === keys.includes('⌥') &&
			(meta || e.ctrlKey === keys.includes('⌃')) &&
			e.code === codeOf(main[0])
		);
	}
</script>

<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { ArrowRight, Check, Search } from 'lucide-svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import { calculate, type Calculation } from './palette/calc';
	import { convert, type Conversion } from './palette/units';
	import {
		decorativeMotion,
		motionEnabled,
		springTiming,
		staggerDelay
	} from '$lib/utils/motion.svelte';

	let {
		open = $bindable(false),
		origin = undefined,
		items,
		actions = [],
		onSelect = undefined,
		placeholder = 'Search apps and actions'
	}: {
		open?: boolean;
		origin?: () => Element | null | undefined;
		items: PaletteItem[];
		actions?: PaletteAction[];
		onSelect?: (item: PaletteItem) => void;
		placeholder?: string;
	} = $props();

	type Row =
		| { type: 'item'; key: string; item: PaletteItem; label: Seg[]; sub: Seg[] | null }
		| { type: 'action'; key: string; action: PaletteAction; label: Seg[] }
		| { type: 'calc'; key: string; calc: Calculation }
		| { type: 'unit'; key: string; conv: Conversion };
	type Scope = 'all' | 'actions' | 'projects';
	type Section = { key: string; title: string; rows: Row[]; offset: number };
	type View = {
		query: string;
		scope: Scope;
		sections: Section[];
		flat: Row[];
		empty: string | null;
	};
	type Group = { key: string; title: string; rows: Row[]; best: number };

	const uid = $props.id();
	const listId = `${uid}-list`;
	const optId = (row: Row) => `${uid}-opt-${row.key}`;
	const RECENT_KEY = 'orchard-palette-recent';
	const RECENT_COUNT = 3;
	const LIMIT = { apps: 6, projects: 3, actions: 4 };
	const BUD = 28;
	const FLIGHT_OVERLAP = 0.12;
	const DRIP_LEAD = 0.13;
	const OPEN_LEAD_MS = 150;
	const COPIED_MS = 1600;
	const SCOPE_LABEL: Record<Scope, string> = { all: '', actions: 'Actions', projects: 'Projects' };

	let layer = $state<HTMLElement>();
	let stage = $state<HTMLElement>();
	let flight = $state<HTMLElement>();
	let bar = $state<HTMLElement>();
	let input = $state<HTMLInputElement>();
	let scroller = $state<HTMLElement>();
	let hl = $state<HTMLElement>();
	let foot = $state<HTMLElement>();

	let phase = $state<'closed' | 'open' | 'closing'>('closed');
	let query = $state('');
	let active = $state(0);
	let view = $state<View | null>(null);
	let oozing = $state(false);
	let box = $state({ w: 640, h: 56 });
	let copied = $state<string | null>(null);
	let recent = $state<string[]>([]);
	let edges = $state({ top: false, bottom: false });
	let mod = $state('⌘');

	let returnTo: HTMLElement | null = null;
	let drop: 'none' | 'pending' | 'open' = 'none';
	let batch = false;
	let launchedAt = 0;
	let dripGen = 0;
	let flightGen = 0;
	let oozeGen = 0;
	let hlPlaced = false;
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let exits: Animation[] = [];
	const entered = new WeakSet<Element>();
	const running = new WeakMap<Element, Map<string, Animation>>();

	function rankItem(item: PaletteItem, q: string): (Row & { type: 'item' }) | null {
		const own = locate(item.label, q);
		if (own) {
			return {
				type: 'item',
				key: `i-${item.id}`,
				item,
				label: segments(item.label, own.ranges),
				sub: item.sublabel ? plain(item.sublabel) : null,
				score: own.score
			} as Row & { type: 'item'; score: number };
		}
		const i = item.sublabel?.toLowerCase().indexOf(q) ?? -1;
		if (!item.sublabel || i < 0) return null;
		return {
			type: 'item',
			key: `i-${item.id}`,
			item,
			label: plain(item.label),
			sub: segments(item.sublabel, [[i, i + q.length]]),
			score: 8
		} as Row & { type: 'item'; score: number };
	}

	function rankAction(action: PaletteAction, q: string): (Row & { type: 'action' }) | null {
		const own = locate(action.label, q);
		if (own) {
			return {
				type: 'action',
				key: `a-${action.id}`,
				action,
				label: segments(action.label, own.ranges),
				score: own.score
			} as Row & { type: 'action'; score: number };
		}
		const hit = action.keywords?.some((k) => k.toLowerCase().startsWith(q));
		if (!hit) return null;
		return {
			type: 'action',
			key: `a-${action.id}`,
			action,
			label: plain(action.label),
			score: 6
		} as Row & { type: 'action'; score: number };
	}

	const scoreOf = (row: Row) => (row as { score?: number }).score ?? 0;

	function byScore<T extends Row>(rows: T[], label: (row: T) => string) {
		return rows.sort((a, b) => scoreOf(a) - scoreOf(b) || label(a).localeCompare(label(b)));
	}

	const itemRow = (item: PaletteItem): Row => ({
		type: 'item',
		key: `i-${item.id}`,
		item,
		label: plain(item.label),
		sub: item.sublabel ? plain(item.sublabel) : null
	});

	const actionRow = (action: PaletteAction): Row => ({
		type: 'action',
		key: `a-${action.id}`,
		action,
		label: plain(action.label)
	});

	function recentItems(): PaletteItem[] {
		const byId = new Map(items.map((i) => [i.id, i]));
		const picked = recent.map((id) => byId.get(id)).filter((i): i is PaletteItem => !!i);
		for (const item of items) {
			if (picked.length >= RECENT_COUNT) break;
			if (item.kind !== 'project' && !picked.includes(item)) picked.push(item);
		}
		return picked.slice(0, RECENT_COUNT);
	}

	function build(raw: string): View {
		let scope: Scope = 'all';
		let text = raw;
		if (raw.startsWith('>')) {
			scope = 'actions';
			text = raw.slice(1);
		} else if (raw.startsWith('#')) {
			scope = 'projects';
			text = raw.slice(1);
		}
		const q = text.trim().toLowerCase();
		const groups: Group[] = [];

		if (scope === 'all' && q) {
			const calc = calculate(text);
			const conv = calc ? null : convert(text);
			if (calc) {
				groups.push({
					key: 'calc',
					title: 'Calculator',
					rows: [{ type: 'calc', key: 'calc', calc }],
					best: -1
				});
			} else if (conv) {
				groups.push({
					key: 'unit',
					title: conv.dimension,
					rows: [{ type: 'unit', key: 'unit', conv }],
					best: -1
				});
			}
		}

		if (!q) {
			if (scope === 'all') {
				const rec = recentItems();
				if (rec.length)
					groups.push({ key: 'recent', title: 'Recent', rows: rec.map(itemRow), best: 0 });
			}
			if (scope !== 'projects' && actions.length) {
				groups.push({ key: 'actions', title: 'Actions', rows: actions.map(actionRow), best: 1 });
			}
			if (scope === 'projects') {
				const projects = items.filter((i) => i.kind === 'project').map(itemRow);
				if (projects.length)
					groups.push({ key: 'projects', title: 'Projects', rows: projects, best: 0 });
			}
		} else {
			const ranked: Group[] = [];
			if (scope !== 'actions') {
				const hits = items
					.filter((i) => scope === 'all' || i.kind === 'project')
					.map((i) => rankItem(i, q))
					.filter((h): h is Row & { type: 'item' } => !!h);
				byScore(hits, (h) => h.item.label);
				const apps = hits.filter((h) => h.item.kind !== 'project').slice(0, LIMIT.apps);
				const projects = hits
					.filter((h) => h.item.kind === 'project')
					.slice(0, scope === 'projects' ? Infinity : LIMIT.projects);
				if (apps.length)
					ranked.push({ key: 'apps', title: 'Apps', rows: apps, best: scoreOf(apps[0]) });
				if (projects.length) {
					ranked.push({
						key: 'projects',
						title: 'Projects',
						rows: projects,
						best: scoreOf(projects[0])
					});
				}
			}
			if (scope !== 'projects') {
				const hits = actions
					.map((a) => rankAction(a, q))
					.filter((h): h is Row & { type: 'action' } => !!h);
				byScore(hits, (h) => h.action.label);
				const top = hits.slice(0, scope === 'actions' ? Infinity : LIMIT.actions);
				if (top.length)
					ranked.push({ key: 'actions', title: 'Actions', rows: top, best: scoreOf(top[0]) });
			}
			ranked.sort((a, b) => a.best - b.best);
			groups.push(...ranked);
		}

		let offset = 0;
		const sections = groups.map((g) => {
			const s = { key: g.key, title: g.title, rows: g.rows, offset };
			offset += g.rows.length;
			return s;
		});
		const flat = sections.flatMap((s) => s.rows);
		return { query: raw, scope, sections, flat, empty: flat.length ? null : text.trim() || raw };
	}

	const results = $derived(phase === 'open' ? build(query) : null);

	const scope = $derived<Scope>(
		query.startsWith('>') ? 'actions' : query.startsWith('#') ? 'projects' : 'all'
	);

	const current = $derived(view?.flat[active] ?? null);

	const countLabel = $derived.by(() => {
		if (!view) return '';
		const n = view.flat.length;
		if (!n) return 'No results';
		const noun =
			view.scope === 'actions' ? 'action' : view.scope === 'projects' ? 'project' : 'result';
		return `${n} ${noun}${n === 1 ? '' : 's'}`;
	});

	const hints = $derived.by(() => {
		const out: { keys: string[]; label: string; done?: boolean }[] = [];
		const row = current;
		if (row?.type === 'item') {
			out.push({ keys: ['↵'], label: 'Open' });
			if (row.item.url) out.push({ keys: [mod, '↵'], label: 'Visit' });
		} else if (row?.type === 'action') {
			out.push({ keys: ['↵'], label: 'Run' });
		} else if (row) {
			out.push(
				copied === row.key
					? { keys: [], label: 'Copied', done: true }
					: { keys: [mod, 'C'], label: 'Copy result' }
			);
		}
		out.push({ keys: ['esc'], label: query ? 'Clear' : 'Close' });
		return out;
	});

	function set(el: HTMLElement | undefined, prop: string, value: string) {
		if (!el) return;
		running.get(el)?.get(prop)?.cancel();
		running.get(el)?.delete(prop);
		el.style.setProperty(prop, value);
	}

	function tween(
		el: HTMLElement | undefined,
		prop: string,
		to: string,
		timing: KeyframeAnimationOptions,
		from?: string
	): Animation | null {
		if (!el) return null;
		let map = running.get(el);
		if (!map) running.set(el, (map = new Map()));
		const start = from ?? getComputedStyle(el).getPropertyValue(prop).trim();
		map.get(prop)?.cancel();
		map.delete(prop);
		el.style.setProperty(prop, to);
		if (!timing.duration || start === to) return null;
		const anim = el.animate([{ [prop]: start }, { [prop]: to }], { ...timing, fill: 'backwards' });
		map.set(prop, anim);
		anim.addEventListener('finish', () => {
			if (map.get(prop) === anim) map.delete(prop);
		});
		return anim;
	}

	const settled = (anim: Animation | null) =>
		anim
			? anim.finished.then(
					() => true,
					() => false
				)
			: Promise.resolve(true);

	function ooze(anim: Animation | null) {
		const gen = ++oozeGen;
		oozing = !!anim;
		settled(anim).then(() => {
			if (gen === oozeGen) oozing = false;
		});
	}

	const physical = () => decorativeMotion() || !motionEnabled();

	function measure() {
		if (!stage || !layer || !bar) return 0;
		const to = stage.getBoundingClientRect();
		const el = origin?.();
		const rect = el?.isConnected ? el.getBoundingClientRect() : null;
		const usable = !!el && !!rect && rect.width > 0 && rect.height > 0;
		let from: { left: number; top: number; width: number; height: number };
		let r0 = 'var(--R)';
		let s0 = 0.92;
		let fade = 1;
		if (usable && el && rect) {
			from = rect;
			const cs = getComputedStyle(el);
			r0 = `${parseFloat(cs.borderTopLeftRadius) || 10}px`;
			const text = el.querySelector('input') ?? el;
			s0 = parseFloat(getComputedStyle(text).fontSize) / parseFloat(getComputedStyle(bar).fontSize);
			fade = 3;
		} else {
			const w = to.width * s0;
			const h = to.height * s0;
			from = {
				left: to.left + (to.width - w) / 2,
				top: to.top + (to.height - h) / 2,
				width: w,
				height: h
			};
		}
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		layer.style.setProperty('--dx', `${dx}px`);
		layer.style.setProperty('--dy', `${dy}px`);
		layer.style.setProperty('--w0', `${from.width}px`);
		layer.style.setProperty('--h0', `${from.height}px`);
		layer.style.setProperty('--r0', r0);
		layer.style.setProperty('--s0', `${s0}`);
		layer.style.setProperty('--fade', `${fade}`);
		layer.style.setProperty('--sw0', `${from.width / to.width}`);
		layer.style.setProperty('--sh0', `${from.height / to.height}`);
		layer.style.setProperty('--bW', `${BUD / to.width}`);
		box = { w: to.width, h: to.height };
		return Math.hypot(dx, dy);
	}

	function show() {
		if (phase === 'open' || !layer) return;
		const fresh = phase === 'closed';
		const from = document.activeElement;
		if (from instanceof HTMLElement && from !== document.body && !layer.contains(from)) {
			returnTo = from;
		} else if (fresh) returnTo = null;
		phase = 'open';
		open = true;
		flightGen++;
		layer.setAttribute('data-floating', '');
		layer.inert = false;
		const distance = measure();
		launchedAt = fresh && physical() ? performance.now() : 0;
		const timing = springTiming('smooth', { distance });
		if (physical()) {
			tween(layer, '--spot-t', '1', timing, fresh ? '0' : undefined);
		} else {
			set(layer, '--spot-t', '1');
			tween(layer, 'opacity', '1', timing, fresh ? '0' : undefined);
		}
		input?.focus({ preventScroll: true });
	}

	function hide(restore: boolean) {
		if (phase !== 'open' || !layer) return;
		phase = 'closing';
		open = false;
		const gen = ++flightGen;
		const delay = drop === 'open' ? FLIGHT_OVERLAP : 0;
		query = '';
		copied = null;
		const home = origin?.();
		if (document.activeElement === input) input?.blur();
		if (restore && returnTo?.isConnected && !home?.contains(returnTo)) {
			returnTo.focus({ preventScroll: true });
		}
		const distance = measure();
		let anim: Animation | null;
		if (physical()) {
			anim = tween(layer, '--spot-t', '0', springTiming('smooth', { exit: true, delay, distance }));
		} else {
			anim = tween(layer, 'opacity', '0', springTiming('smooth', { delay }));
		}
		settled(anim).then(() => {
			if (gen === flightGen && phase === 'closing') land();
		});
	}

	function land() {
		phase = 'closed';
		dripGen++;
		drop = 'none';
		batch = false;
		for (const a of exits) a.cancel();
		exits = [];
		view = null;
		active = 0;
		hlPlaced = false;
		set(layer, '--spot-t', '0');
		set(layer, 'opacity', '1');
		set(layer, '--spot-fall', '0');
		set(layer, '--spot-spread', '0');
		set(layer, '--spot-h', `${BUD}`);
		set(layer, '--spot-o', '1');
		set(hl, 'opacity', '0');
	}

	function animateRow(el: Element, delay: number) {
		const frames = decorativeMotion()
			? [
					{ opacity: 0, transform: 'translateY(-0.375rem) scale(0.97)' },
					{ opacity: 1, transform: 'none' }
				]
			: [{ opacity: 0 }, { opacity: 1 }];
		(el as HTMLElement).animate(frames, {
			...springTiming('smooth', { delay }),
			fill: 'backwards'
		});
	}

	function enterAll() {
		if (!scroller) return;
		const rows = [...scroller.querySelectorAll('[data-row]')];
		for (const [i, el] of rows.entries()) {
			entered.add(el);
			if (motionEnabled()) animateRow(el, DRIP_LEAD + staggerDelay(i));
		}
	}

	function rowIn(index: number) {
		return (el: Element) => {
			if (batch || entered.has(el)) return;
			entered.add(el);
			if (motionEnabled()) animateRow(el, staggerDelay(index));
		};
	}

	function dripIn(height: number) {
		enterAll();
		placeHighlight(view, active, DRIP_LEAD);
		if (physical()) {
			set(layer, '--spot-o', '1');
			ooze(tween(layer, '--spot-fall', '1', springTiming('smooth')));
			tween(layer, '--spot-spread', '1', springTiming('smooth', { delay: 0.1 }));
			tween(
				layer,
				'--spot-h',
				`${height}`,
				springTiming('smooth', { delay: DRIP_LEAD, distance: height })
			);
			return;
		}
		set(layer, '--spot-fall', '1');
		set(layer, '--spot-spread', '1');
		set(layer, '--spot-h', `${height}`);
		tween(layer, '--spot-o', '1', springTiming('smooth'), '0');
	}

	function resize(height: number) {
		if (!layer) return;
		if (!decorativeMotion()) return set(layer, '--spot-h', `${height}`);
		const now = parseFloat(getComputedStyle(layer).getPropertyValue('--spot-h')) || BUD;
		tween(
			layer,
			'--spot-h',
			`${height}`,
			springTiming('smooth', { distance: Math.abs(height - now) })
		);
	}

	function dripOut() {
		if (!layer) return Promise.resolve(true);
		if (!physical()) return settled(tween(layer, '--spot-o', '0', springTiming('smooth')));
		const rows = scroller ? [...scroller.querySelectorAll<HTMLElement>('[data-row]')] : [];
		if (hl) rows.push(hl);
		exits = rows.map((el, i) => {
			const cs = getComputedStyle(el);
			const frames =
				el === hl
					? [{ opacity: cs.opacity }, { opacity: 0 }]
					: [
							{ opacity: cs.opacity, transform: cs.transform },
							{ opacity: 0, transform: 'translateY(-0.5rem) scale(0.96)' }
						];
			return el.animate(frames, {
				...springTiming('snappy', {
					exit: true,
					delay: el === hl ? 0 : staggerDelay(rows.length - 1 - i) / 2
				}),
				fill: 'forwards'
			});
		});
		const now = parseFloat(getComputedStyle(layer).getPropertyValue('--spot-h')) || BUD;
		tween(layer, '--spot-h', `${BUD}`, springTiming('smooth', { exit: true, distance: now - BUD }));
		tween(layer, '--spot-spread', '0', springTiming('smooth', { exit: true, delay: 0.04 }));
		const fall = tween(
			layer,
			'--spot-fall',
			'0',
			springTiming('smooth', { exit: true, delay: 0.08 })
		);
		ooze(fall);
		return settled(fall);
	}

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	function measureDrop() {
		return (scroller?.offsetHeight ?? 0) + (foot?.offsetHeight ?? 0);
	}

	function syncEdges() {
		if (!scroller) return;
		const { scrollTop, clientHeight, scrollHeight } = scroller;
		const top = scrollTop > 1;
		const bottom = scrollTop + clientHeight < scrollHeight - 1;
		if (top !== edges.top || bottom !== edges.bottom) edges = { top, bottom };
	}

	async function present(next: View | null) {
		const gen = ++dripGen;
		if (next) {
			for (const a of exits) a.cancel();
			exits = [];
			const fresh = drop === 'none';
			if (fresh) {
				drop = 'pending';
				batch = true;
				hlPlaced = false;
			}
			const prev = view;
			const sameQuery = !!prev && prev.query === next.query;
			const prevKey = sameQuery ? prev.flat[active]?.key : undefined;
			const keep = prevKey ? next.flat.findIndex((r) => r.key === prevKey) : -1;
			if (!sameQuery) {
				copied = null;
				if (scroller) scroller.scrollTop = 0;
			}
			view = next;
			active = keep >= 0 ? keep : 0;
			await tick();
			if (gen !== dripGen) return;
			syncEdges();
			const height = measureDrop();
			if (drop === 'open') return resize(height);
			const wait = launchedAt ? OPEN_LEAD_MS - (performance.now() - launchedAt) : 0;
			if (wait > 0) await sleep(wait);
			if (gen !== dripGen) return;
			launchedAt = 0;
			drop = 'open';
			batch = false;
			dripIn(measureDrop());
			return;
		}
		if (drop === 'none') return;
		const was = drop;
		drop = 'none';
		batch = false;
		if (was === 'open') await dripOut();
		if (gen !== dripGen) return;
		view = null;
		if (!physical()) {
			set(layer, '--spot-fall', '0');
			set(layer, '--spot-spread', '0');
			set(layer, '--spot-h', `${BUD}`);
		}
	}

	$effect(() => {
		const next = results;
		untrack(() => {
			present(next);
		});
	});

	$effect(() => {
		const want = open;
		untrack(() => {
			if (want && phase !== 'open') show();
			else if (!want && phase === 'open') hide(true);
		});
	});

	function placeHighlight(v: View | null, index: number, delay = 0) {
		if (!hl) return;
		const row = v?.flat[index];
		const el =
			row && (row.type === 'item' || row.type === 'action')
				? document.getElementById(optId(row))
				: null;
		if (!el || batch) {
			set(hl, 'opacity', '0');
			hlPlaced = false;
			return;
		}
		const to = `translateY(${el.offsetTop}px)`;
		if (hlPlaced && decorativeMotion()) {
			tween(hl, 'transform', to, springTiming('snappy'));
			return;
		}
		set(hl, 'transform', to);
		const first = !hlPlaced;
		hlPlaced = true;
		if (first && motionEnabled()) {
			tween(hl, 'opacity', '1', springTiming('smooth', { delay }), '0');
		} else set(hl, 'opacity', '1');
	}

	$effect(() => {
		const index = active;
		const v = view;
		untrack(() => placeHighlight(v, index));
	});

	function reveal(index: number) {
		const row = view?.flat[index];
		const el = row ? document.getElementById(optId(row)) : null;
		if (!el || !scroller) return;
		if (index === 0) {
			scroller.scrollTop = 0;
			return;
		}
		const pad = 8;
		const group = el.closest<HTMLElement>('[role="group"]');
		const leads = group?.querySelector('[role="option"]') === el;
		const top = leads && group ? group.offsetTop : el.offsetTop - pad;
		const bottom = el.offsetTop + el.offsetHeight + pad;
		if (top < scroller.scrollTop) scroller.scrollTop = top;
		else if (bottom > scroller.scrollTop + scroller.clientHeight) {
			scroller.scrollTop = bottom - scroller.clientHeight;
		}
	}

	function remember(id: string) {
		recent = [id, ...recent.filter((r) => r !== id)].slice(0, 8);
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
		} catch {
			return;
		}
	}

	function writeFallback(text: string) {
		if (!flight) return false;
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.cssText = 'position:absolute;opacity:0;pointer-events:none';
		flight.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		area.remove();
		input?.focus({ preventScroll: true });
		return ok;
	}

	function flash(key: string) {
		copied = key;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			if (copied === key) copied = null;
		}, COPIED_MS);
	}

	function copy(row: Row & { type: 'calc' | 'unit' }) {
		const text = row.type === 'calc' ? row.calc.copy : row.conv.copy;
		const done = () => flash(row.key);
		const fail = () => {
			if (writeFallback(text)) done();
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fail);
		else fail();
	}

	function choose(row: Row, visit = false) {
		if (row.type === 'calc' || row.type === 'unit') return copy(row);
		if (row.type === 'action') {
			hide(true);
			row.action.run();
			return;
		}
		const item = row.item;
		remember(item.id);
		hide(true);
		if (visit && item.url) {
			window.open(item.url, '_blank', 'noopener');
			return;
		}
		if (onSelect) onSelect(item);
		else goto(item.href);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		const flat = view?.flat ?? [];
		const cmd = e.metaKey || e.ctrlKey;
		if (e.key === 'Escape') {
			e.preventDefault();
			if (query) query = '';
			else hide(true);
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			return;
		}
		const down = e.key === 'ArrowDown' || (e.ctrlKey && !e.metaKey && e.code === 'KeyN');
		const up = e.key === 'ArrowUp' || (e.ctrlKey && !e.metaKey && e.code === 'KeyP');
		if (down || up) {
			if (!flat.length) return;
			e.preventDefault();
			active = (active + (down ? 1 : -1) + flat.length) % flat.length;
			reveal(active);
			return;
		}
		if (e.key === 'Enter') {
			const row = flat[active];
			if (!row) return;
			e.preventDefault();
			choose(row, cmd);
			return;
		}
		if (cmd && e.code === 'KeyC') {
			const row = flat[active];
			const collapsed = input?.selectionStart === input?.selectionEnd;
			if (row && (row.type === 'calc' || row.type === 'unit') && collapsed) {
				e.preventDefault();
				copy(row);
			}
		}
	}

	function onfocusout(e: FocusEvent) {
		if (phase !== 'open' || !document.hasFocus()) return;
		const to = e.relatedTarget;
		if (to instanceof Node && flight?.contains(to)) return;
		hide(false);
	}

	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			const toggle =
				e.code === 'KeyK' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.repeat;
			if (toggle) {
				e.preventDefault();
				e.stopImmediatePropagation();
				if (phase === 'open') hide(true);
				else show();
				return;
			}
			if (phase !== 'open' || !(e.metaKey || e.ctrlKey || e.altKey)) return;
			const hit = actions.find((a) => a.shortcut && pressed(a.shortcut, e));
			if (!hit) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			hide(true);
			hit.run();
		};
		window.addEventListener('keydown', onkey, true);
		return () => window.removeEventListener('keydown', onkey, true);
	});

	$effect(() => {
		mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
		try {
			const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
			if (Array.isArray(saved)) recent = saved.filter((s) => typeof s === 'string');
		} catch {
			recent = [];
		}
	});

	$effect(() => {
		const urls = items.map((i) => i.icon).filter((s): s is string => !!s && !warmed.has(s));
		if (!urls.length) return;
		const run = () => {
			for (const src of urls) {
				warmed.add(src);
				const img = new Image();
				img.decoding = 'async';
				img.src = src;
				img.decode().catch(() => undefined);
			}
		};
		if ('requestIdleCallback' in window) {
			const handle = requestIdleCallback(run, { timeout: 1500 });
			return () => cancelIdleCallback(handle);
		}
		const handle = setTimeout(run, 300);
		return () => clearTimeout(handle);
	});

	$effect(() => {
		const warm = async () => {
			if (phase !== 'closed' || view) return;
			batch = true;
			view = untrack(() => build(''));
			await tick();
			if (drop === 'none') batch = false;
		};
		if ('requestIdleCallback' in window) {
			const handle = requestIdleCallback(warm, { timeout: 1200 });
			return () => cancelIdleCallback(handle);
		}
		const handle = setTimeout(warm, 400);
		return () => clearTimeout(handle);
	});

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return () => node.remove();
	}

	function holdWheel(node: HTMLElement) {
		const onwheel = (e: WheelEvent) => {
			if (phase !== 'open') return;
			if (scroller && e.target instanceof Node && scroller.contains(e.target)) return;
			e.preventDefault();
		};
		node.addEventListener('wheel', onwheel, { passive: false });
		return () => node.removeEventListener('wheel', onwheel);
	}
</script>

<div
	class="layer"
	data-floating={phase !== 'closed' || undefined}
	inert={phase === 'closed'}
	bind:this={layer}
	{@attach portal}
	{@attach holdWheel}
>
	<div
		class="scrim carry"
		aria-hidden="true"
		onpointerdown={() => hide(true)}
		onmousedown={(e) => e.preventDefault()}
	></div>
	<div class="stage carry" bind:this={stage}>
		<div
			class="flight carry"
			bind:this={flight}
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			tabindex="-1"
			{onfocusout}
			onmousedown={(e) => {
				if (e.target !== input) e.preventDefault();
			}}
		>
			<span class="halo halo--cap carry" aria-hidden="true"></span>
			<span class="halo halo--drop carry" aria-hidden="true"></span>
			<span class="drop carry" aria-hidden="true"></span>
			<span class="cap carry" aria-hidden="true"></span>
			<svg class="goo carry" aria-hidden="true">
				<defs class="carry">
					<filter
						id="{uid}-goo"
						filterUnits="userSpaceOnUse"
						x="-24"
						y={box.h - 34}
						width={box.w + 48}
						height="80"
						color-interpolation-filters="sRGB"
					>
						<feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
						<feColorMatrix
							in="blur"
							type="matrix"
							values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
							result="goo"
						/>
						<feComposite in="SourceGraphic" in2="goo" operator="atop" />
					</filter>
					<clipPath id="{uid}-seam" class="carry"><rect class="seam carry" /></clipPath>
				</defs>
				{#if oozing}
					<g class="carry" clip-path="url(#{uid}-seam)">
						<g class="carry" filter="url(#{uid}-goo)">
							<rect class="goo-drop carry" />
							<rect class="goo-cap carry" />
						</g>
					</g>
				{/if}
			</svg>

			<div class="bar carry" bind:this={bar}>
				<span class="glyph" aria-hidden="true"><Search size={18} strokeWidth={2} /></span>
				<input
					bind:this={input}
					bind:value={query}
					type="text"
					class="field"
					role="combobox"
					aria-label={placeholder}
					aria-expanded={!!view && phase === 'open'}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={current ? optId(current) : undefined}
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					{placeholder}
					{onkeydown}
				/>
				{#if scope !== 'all'}
					<span class="scope"><span class="scope-text">{SCOPE_LABEL[scope]}</span></span>
				{/if}
			</div>

			<div class="results carry">
				<div
					class="scroller"
					id={listId}
					role="listbox"
					aria-label="Results"
					data-fade-top={edges.top || undefined}
					data-fade-bottom={edges.bottom || undefined}
					bind:this={scroller}
					onscroll={syncEdges}
				>
					<span class="hl" aria-hidden="true" bind:this={hl}></span>
					{#if view?.empty}
						<p class="none" data-row {@attach rowIn(0)}>
							<span class="none-text">No matches for “{view.empty}”</span>
						</p>
					{/if}
					{#each view?.sections ?? [] as section (section.key)}
						<div class="set" role="group" aria-labelledby="{uid}-{section.key}">
							<div
								class="heading"
								id="{uid}-{section.key}"
								data-row
								{@attach rowIn(section.offset)}
							>
								{section.title}
							</div>
							<div class="rows">
								{#each section.rows as row, i (row.key)}
									{@render option(row, section.offset + i)}
								{/each}
							</div>
						</div>
					{/each}
				</div>
				<div class="foot carry" bind:this={foot}>
					<span class="count" aria-live="polite">{countLabel}</span>
					<span class="hints">
						{#each hints as hint (hint.label)}
							<span class="hint" class:hint--done={hint.done}>
								{#if hint.done}
									<span class="done-glyph" aria-hidden="true"
										><Check size={13} strokeWidth={2.5} /></span
									>
								{:else}
									<Kbd keys={hint.keys} />
								{/if}
								<span class="hint-text">{hint.label}</span>
							</span>
						{/each}
					</span>
				</div>
			</div>
		</div>
	</div>
</div>

{#snippet marks(segs: Seg[])}{#each segs as s, j (j)}{#if s.hit}<mark class="hit">{s.text}</mark
			>{:else}{s.text}{/if}{/each}{/snippet}

{#snippet option(row: Row, index: number)}
	<div
		id={optId(row)}
		class="option option--{row.type}"
		role="option"
		tabindex="-1"
		aria-selected={index === active}
		data-row
		onpointermove={() => {
			if (active !== index) active = index;
		}}
		onclick={(e) => choose(row, e.metaKey || e.ctrlKey)}
		onkeydown={(e) => {
			if (e.key === 'Enter') choose(row);
		}}
		{@attach rowIn(index + 1)}
	>
		{#if row.type === 'item'}
			<span class="lead">
				<AppIcon name={row.item.label} kind={row.item.kind} icon={row.item.icon} size="sm" />
			</span>
			<span class="name">{@render marks(row.label)}</span>
			{#if row.sub}<span class="sub">{@render marks(row.sub)}</span>{/if}
			{#if row.item.status}
				<span class="trail">
					<StatusDot meta={row.item.status} size={7} />
					<span class="state">{row.item.status.label}</span>
				</span>
			{/if}
		{:else if row.type === 'action'}
			{@const Glyph = row.action.icon}
			<span class="lead lead--glyph"><Glyph size={14} strokeWidth={2} /></span>
			<span class="name">{@render marks(row.label)}</span>
			{#if row.action.hint}<span class="sub">{row.action.hint}</span>{/if}
			{#if row.action.shortcut}
				<span class="trail"><Kbd keys={keysOf(row.action.shortcut)} /></span>
			{/if}
		{:else}
			{@const left = row.type === 'calc' ? row.calc.expression : row.conv.from.text}
			{@const right = row.type === 'calc' ? row.calc.formatted : row.conv.to.text}
			<span class="figure figure--ask">{left}</span>
			<span class="arrow" class:arrow--done={copied === row.key} aria-hidden="true">
				{#if copied === row.key}<Check size={16} strokeWidth={2.25} />{:else}<ArrowRight
						size={16}
						strokeWidth={2}
					/>{/if}
			</span>
			<span class="figure figure--answer">{right}</span>
			{#if row.type === 'unit'}
				<span class="caption">{row.conv.from.name}</span>
				<span class="caption caption--answer">{row.conv.to.name}</span>
			{/if}
		{/if}
	</div>
{/snippet}

<style>
	@property --spot-t {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --spot-fall {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --spot-spread {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --spot-h {
		syntax: '<number>';
		inherits: false;
		initial-value: 28;
	}
	@property --spot-o {
		syntax: '<number>';
		inherits: false;
		initial-value: 1;
	}
	@property --t {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --in {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --sx {
		syntax: '<number>';
		inherits: false;
		initial-value: 1;
	}
	@property --sy {
		syntax: '<number>';
		inherits: false;
		initial-value: 1;
	}
	@property --sb {
		syntax: '<number>';
		inherits: false;
		initial-value: 1;
	}
	@property --cw {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --ch {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --cr {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --bw {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --dh {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --dr {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}
	@property --drop-y {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}

	.layer {
		--W: min(40rem, calc(100vw - 2rem));
		--H: 3.5rem;
		--B: 28px;
		--gap: 0.75rem;
		--foot: 2.5rem;
		--list-max: 26rem;
		--R: calc(var(--radius-panel) * var(--corner-scale));
		--inner: calc((var(--radius-panel) - 0.5rem) * var(--corner-scale));
		--r0: var(--R);
		--w0: 36rem;
		--h0: 3.25rem;
		--dx: 0px;
		--dy: 0px;
		--s0: 1;
		--sw0: 0.92;
		--sh0: 0.92;
		--bW: 0.05;
		--fade: 1;
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		visibility: hidden;
		pointer-events: none;
	}
	.layer[data-floating] {
		visibility: visible;
	}
	.carry {
		--spot-t: inherit;
		--spot-fall: inherit;
		--spot-spread: inherit;
		--spot-h: inherit;
		--spot-o: inherit;
		--t: clamp(0, var(--spot-t), 1);
		--in: clamp(0, var(--spot-t) * var(--fade), 1);
		--sx: calc(var(--sw0) + (1 - var(--sw0)) * var(--spot-t));
		--sy: calc(var(--sh0) + (1 - var(--sh0)) * var(--spot-t));
		--sb: calc(var(--s0) + (1 - var(--s0)) * var(--spot-t));
		--cw: max(var(--B), calc(var(--w0) + (var(--W) - var(--w0)) * var(--spot-t)));
		--ch: max(1rem, calc(var(--h0) + (var(--H) - var(--h0)) * var(--spot-t)));
		--cr: max(0px, calc(var(--r0) + (var(--R) - var(--r0)) * var(--spot-t)));
		--bw: max(calc(var(--B) / 2), calc(var(--B) + (var(--cw) - var(--B)) * var(--spot-spread)));
		--dh: max(14px, calc(var(--spot-h) * 1px));
		--dr: calc(var(--B) / 2 + (var(--R) - var(--B) / 2) * clamp(0, var(--spot-spread), 1));
		--drop-y: calc(var(--ch) - var(--B) - 2px + (var(--gap) + var(--B) + 2px) * var(--spot-fall));
	}

	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(0 0 0 / 0.16);
		opacity: var(--t);
	}
	:global(:root.dark) .scrim {
		background: rgb(0 0 0 / 0.4);
	}
	.layer[data-floating] .scrim {
		pointer-events: auto;
	}
	.stage {
		position: absolute;
		top: clamp(4rem, 15vh, 8.5rem);
		left: 50%;
		width: var(--W);
		height: var(--H);
		margin-left: calc(var(--W) / -2);
	}
	.flight {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--W);
		height: var(--H);
		outline: none;
		transform: translate(
			calc((1 - var(--spot-t)) * var(--dx)),
			calc((1 - var(--spot-t)) * var(--dy))
		);
		will-change: transform;
	}
	.layer[data-floating] .flight {
		pointer-events: auto;
	}

	.halo {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--W);
		transform-origin: 0 0;
		box-shadow:
			0 10px 24px rgb(0 0 0 / 0.07),
			0 28px 60px rgb(0 0 0 / 0.12);
		pointer-events: none;
	}
	.halo--cap {
		height: var(--H);
		border-radius: var(--R);
		opacity: var(--in);
		transform: scale(var(--sx), var(--sy));
	}
	.halo--drop {
		height: 100px;
		border-radius: var(--R);
		opacity: calc(clamp(0, var(--spot-fall), 1) * var(--spot-o) * var(--in));
		transform: translate(calc((var(--cw) - var(--bw)) / 2), var(--drop-y))
			scale(
				max(0.01, calc(var(--bW) + (var(--sx) - var(--bW)) * var(--spot-spread))),
				calc(max(14, var(--spot-h)) / 100)
			);
	}
	.cap,
	.drop {
		position: absolute;
		top: 0;
		left: 0;
		corner-shape: var(--corner);
		background: var(--bg-overlay);
		box-shadow: 0 0 0 0.5px var(--material-glass-edge);
		pointer-events: none;
	}
	.cap {
		width: var(--cw);
		height: var(--ch);
		border-radius: var(--cr);
		opacity: var(--in);
	}
	.drop {
		width: var(--bw);
		height: var(--dh);
		border-radius: var(--dr);
		opacity: calc(var(--spot-o) * var(--in));
		transform: translate(calc((var(--cw) - var(--bw)) / 2), var(--drop-y));
	}
	.goo {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--W);
		height: 8rem;
		overflow: visible;
		pointer-events: none;
	}
	.goo-cap {
		x: 0;
		y: 0;
		width: var(--cw);
		height: var(--ch);
		rx: var(--cr);
		fill: var(--bg-overlay);
	}
	.goo-drop {
		x: calc((var(--cw) - var(--bw)) / 2);
		y: var(--drop-y);
		width: var(--bw);
		height: var(--dh);
		rx: var(--dr);
		fill: var(--bg-overlay);
		opacity: var(--spot-o);
	}
	.seam {
		x: -2rem;
		y: calc(var(--ch) - 0.75rem);
		width: calc(var(--W) + 4rem);
		height: calc(var(--gap) + 1.5rem);
	}

	.bar {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: var(--W);
		height: var(--H);
		padding: 0 1.125rem;
		color: var(--text-muted);
		font-size: var(--text-title-3);
		opacity: var(--in);
		transform-origin: 0 50%;
		transform: translateY(calc((var(--ch) - var(--H)) / 2)) scale(var(--sb));
		cursor: text;
	}
	.glyph {
		display: flex;
		flex-shrink: 0;
	}
	.field {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-default);
		font: inherit;
		font-size: 1em;
		letter-spacing: var(--track-body);
		outline: none;
		appearance: none;
	}
	.field::placeholder {
		color: var(--text-faint);
	}
	.scope {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		height: 1.5rem;
		padding: 0 0.5rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.scope-text {
		text-box: trim-both cap alphabetic;
	}

	.results {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--W);
		height: calc(var(--list-max) + var(--foot) + 2rem);
		color: var(--text-default);
		font-size: var(--text-body);
		opacity: var(--spot-o);
		transform: translate(
			calc((var(--cw) - var(--W)) / 2),
			calc(var(--ch) + var(--gap) - (1 - var(--spot-fall)) * (var(--gap) + var(--B) + 2px))
		);
		clip-path: inset(
			0 calc((var(--W) - var(--bw)) / 2) max(0px, calc(100% - var(--dh)))
				calc((var(--W) - var(--bw)) / 2) round min(var(--dr), var(--radius-panel))
		);
	}
	.scroller {
		--fade-top: 0px;
		--fade-bottom: 0px;
		position: relative;
		max-height: var(--list-max);
		padding: 0.5rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: none;
		mask-image: linear-gradient(
			to bottom,
			transparent,
			black var(--fade-top),
			black calc(100% - var(--fade-bottom)),
			transparent
		);
	}
	.scroller[data-fade-top] {
		--fade-top: 1.5rem;
	}
	.scroller[data-fade-bottom] {
		--fade-bottom: 1.5rem;
	}
	.scroller::-webkit-scrollbar {
		display: none;
	}
	.hl {
		position: absolute;
		top: 0;
		right: 0.5rem;
		left: 0.5rem;
		height: 2.75rem;
		border-radius: var(--inner);
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 6.5%, transparent);
		opacity: 0;
		pointer-events: none;
	}
	.heading {
		padding: 0.75rem 0.75rem 0.375rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		line-height: var(--lh-caption);
		text-box: trim-both cap alphabetic;
		user-select: none;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.option {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 2.75rem;
		padding: 0 0.75rem;
		border-radius: var(--inner);
		corner-shape: var(--corner);
		cursor: default;
		user-select: none;
	}
	.lead {
		position: relative;
		display: flex;
		flex-shrink: 0;
	}
	.lead--glyph {
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		color: var(--text-muted);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.option--action[aria-selected='true'] .lead--glyph {
		background: var(--accent-subtle);
		color: var(--accent);
	}
	.name,
	.sub,
	.state,
	.none-text,
	.hint-text,
	.count,
	.figure,
	.caption {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.name {
		flex-shrink: 0;
		max-width: 55%;
		color: var(--text-default);
	}
	.sub {
		flex: 1;
		min-width: 0;
		color: var(--text-faint);
		font-size: var(--text-callout);
	}
	.hit {
		background: none;
		color: inherit;
		font-weight: var(--weight-medium);
	}
	.sub .hit {
		color: var(--text-muted);
	}
	.trail {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}
	.state {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}

	.option--calc,
	.option--unit {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-content: center;
		align-items: end;
		gap: 0.625rem 1rem;
		height: 5rem;
		padding: 0 1.25rem;
		background: color-mix(in oklab, var(--neutral-10) 4%, transparent);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 6%, transparent);
		transition: box-shadow var(--dur-fast) ease;
	}
	.option--calc[aria-selected='true'],
	.option--unit[aria-selected='true'] {
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--neutral-10) 13%, transparent);
	}
	.figure {
		min-width: 0;
		font-variant-numeric: tabular-nums;
	}
	.figure--ask {
		color: var(--text-muted);
		font-size: var(--text-title-3);
	}
	.figure--answer {
		color: var(--text-default);
		font-size: var(--text-title-1);
		font-weight: var(--weight-medium);
		letter-spacing: var(--track-title);
		text-align: right;
	}
	.caption {
		grid-column: 1;
		min-width: 0;
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
	.caption--answer {
		grid-column: 3;
		text-align: right;
	}
	.arrow {
		display: flex;
		align-self: center;
		color: var(--text-faint);
	}
	.arrow--done {
		color: var(--accent);
	}

	.none {
		display: flex;
		margin: 0;
		padding: 1.25rem 0.75rem;
		color: var(--text-muted);
	}

	.foot {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		width: var(--W);
		height: var(--foot);
		padding: 0 1.25rem;
		border-radius: 0 0 var(--R) var(--R);
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 3%, transparent);
		box-shadow: inset 0 0.5px 0 var(--border-default);
		color: var(--text-muted);
		font-size: var(--text-caption);
		transform: translateY(calc(var(--dh) - var(--foot)));
	}
	.count {
		min-width: 0;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.hints {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 1rem;
	}
	.hint {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.hint--done {
		color: var(--text-default);
	}
	.done-glyph {
		display: flex;
		color: var(--accent);
	}
</style>
