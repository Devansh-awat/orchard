<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { animate } from 'motion';
	import { ArrowLeft } from 'lucide-svelte';
	import { motion, transition } from '@orchardlabs/graft-ui/utils/motion.svelte';
	import Pip from '../mascot/Pip.svelte';
	import { TOUR_BEATS, type TourStep } from './beats';

	let {
		onsession,
		onfinish
	}: {
		onsession: (id: string | null) => void;
		onfinish: (completed: boolean) => void;
	} = $props();

	const PAD = 8;
	const PANEL = 160;
	const EDGE = 3;
	const HEAD = 32;
	const GAP = 16;
	const CARD_W = 340;
	const CARD_MIN = 240;

	let index = $state(0);
	let busy = $state(false);
	type Box = { x: number; y: number; w: number; h: number };
	const RADIUS = 12;

	let hole: Box | null = null;
	let shown: Box | null = null;
	let blurEl = $state<HTMLDivElement | null>(null);
	let ringEl = $state<HTMLDivElement | null>(null);
	let moving: { stop: () => void } | null = null;
	let layerEl = $state<HTMLDialogElement | null>(null);
	let cardEl = $state<HTMLDivElement | null>(null);
	let bodyEl = $state<HTMLDivElement | null>(null);
	let session: string | null = null;
	let run = 0;

	let shownIndex = $state(0);
	const beat = $derived(TOUR_BEATS[shownIndex]);
	const last = $derived(shownIndex === TOUR_BEATS.length - 1);

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function frame() {
		return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}

	function visible(selector: string): HTMLElement[] {
		return [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		});
	}

	async function findAll(selector: string, timeout = 3000): Promise<HTMLElement[]> {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			const found = visible(selector);
			if (found.length > 0) return found;
			await frame();
		}
		return [];
	}

	async function find(selector: string, timeout = 3000): Promise<HTMLElement | null> {
		return (await findAll(selector, timeout))[0] ?? null;
	}

	async function step(s: TourStep): Promise<boolean> {
		if (s.kind === 'session') {
			if (s.id === session) return false;
			session = s.id;
			onsession(s.id);
			await frame();
			return false;
		}
		if (s.kind === 'escape') {
			let closed = false;
			for (const el of document.querySelectorAll<HTMLElement>('[popover]:popover-open')) {
				el.hidePopover();
				closed = true;
			}
			const close = [...document.querySelectorAll('dialog[open]')]
				.find((d) => d !== layerEl)
				?.querySelector<HTMLElement>('[aria-label="Close"]');
			if (close) {
				close.click();
				closed = true;
			}
			if (closed) await sleep(180);
			return closed;
		}
		const el = await find(s.selector);
		el?.click();
		return true;
	}

	function paint(box: Box) {
		shown = box;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const r = Math.min(RADIUS, box.w / 2, box.h / 2);
		const { x, y, w, h } = box;
		const cut =
			w > 0 && h > 0
				? ` M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
				: '';
		if (blurEl) blurEl.style.clipPath = `path(evenodd, "M0 0 H${vw} V${vh} H0 Z${cut}")`;
		if (ringEl) {
			Object.assign(ringEl.style, {
				left: `${x}px`,
				top: `${y}px`,
				width: `${w}px`,
				height: `${h}px`,
				opacity: w > 0 ? '1' : '0'
			});
		}
	}

	function fit(width: number): number {
		if (!cardEl) return 220;
		cardEl.style.width = `${width}px`;
		return cardEl.offsetHeight;
	}

	function place(r: Box | null): { left: number; top: number; width: number } {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const full = Math.min(CARD_W, vw - GAP * 2);
		const clampTop = (top: number, ch: number) =>
			Math.min(Math.max(GAP + HEAD, top), Math.max(GAP + HEAD, vh - ch - GAP));
		if (!r) {
			const ch = fit(full);
			return { left: (vw - full) / 2, top: clampTop((vh - ch) / 2, ch), width: full };
		}
		const rightSpace = vw - GAP - (r.x + r.w + GAP);
		if (rightSpace >= CARD_MIN) {
			const width = Math.min(CARD_W, rightSpace);
			return { left: r.x + r.w + GAP, top: clampTop(r.y, fit(width)), width };
		}
		const leftSpace = r.x - GAP * 2;
		if (leftSpace >= CARD_MIN) {
			const width = Math.min(CARD_W, leftSpace);
			return { left: r.x - GAP - width, top: clampTop(r.y, fit(width)), width };
		}
		const ch = fit(full);
		const left = Math.min(Math.max(GAP, r.x), vw - full - GAP);
		if (r.y + r.h + GAP + HEAD + ch <= vh - GAP) {
			return { left, top: r.y + r.h + GAP + HEAD, width: full };
		}
		return { left, top: clampTop(r.y - GAP - ch, ch), width: full };
	}

	async function measure(restack = false) {
		const target = TOUR_BEATS[index].target;
		const targets = target ? await findAll(target) : [];
		if (targets.length === 0) {
			hole = null;
		} else {
			const rects = targets.map((el) => el.getBoundingClientRect());
			const left = Math.min(...rects.map((r) => r.left));
			const top = Math.min(...rects.map((r) => r.top));
			const outer = Math.max(...rects.map((r) => r.right));
			const under = Math.max(...rects.map((r) => r.bottom));
			const pad = Math.min(outer - left, under - top) >= PANEL ? 0 : PAD;
			const x = Math.max(EDGE, left - pad);
			const y = Math.max(EDGE, top - pad);
			const right = Math.min(window.innerWidth - EDGE, outer + pad);
			const bottom = Math.min(window.innerHeight - EDGE, under + pad);
			hole = { x, y, w: right - x, h: bottom - y };
		}
		const box = hole ?? {
			x: window.innerWidth / 2,
			y: window.innerHeight / 2,
			w: 0,
			h: 0
		};
		const from = shown ?? box;
		moving?.stop();
		moving = animate(0, 1, {
			...transition('snappy'),
			onUpdate: (t) =>
				paint({
					x: from.x + (box.x - from.x) * t,
					y: from.y + (box.y - from.y) * t,
					w: from.w + (box.w - from.w) * t,
					h: from.h + (box.h - from.h) * t
				})
		});
		if (!shown) paint(box);
		shownIndex = index;
		await tick();
		if (!cardEl || !layerEl) return;
		const open = layerEl.open;
		const fresh = !open || restack || !hole;
		if (fresh) {
			if (open) layerEl.close();
			cardEl.style.opacity = '0';
			layerEl.showModal();
			const primary = cardEl.querySelector<HTMLButtonElement>('.gh-btn--primary');
			primary?.blur();
			primary?.focus({ preventScroll: true, focusVisible: false });
		}
		const pos = place(hole);
		const to = { left: `${pos.left}px`, top: `${pos.top}px` };
		if (fresh) {
			Object.assign(cardEl.style, to);
			motion(
				cardEl,
				{
					left: [to.left, to.left],
					top: [to.top, to.top],
					opacity: [0, 1],
					y: [6, 0]
				},
				'snappy'
			);
		} else {
			motion(cardEl, to, 'snappy');
			if (bodyEl) motion(bodyEl, { opacity: [0, 1] }, 'snappy');
		}
	}

	async function show(next: number) {
		const mine = ++run;
		busy = true;
		index = next;
		let restack = false;
		for (const s of TOUR_BEATS[next].before ?? []) {
			if (mine !== run) return;
			restack = (await step(s)) || restack;
		}
		if (mine !== run) return;
		await measure(restack);
		busy = false;
	}

	function go(delta: number) {
		if (busy) return;
		const next = index + delta;
		if (next < 0) return;
		if (next >= TOUR_BEATS.length) {
			onfinish(true);
			return;
		}
		void show(next);
	}

	function onkey(e: KeyboardEvent) {
		const keys: Record<string, () => void> = {
			ArrowRight: () => go(1),
			Enter: () => go(1),
			ArrowLeft: () => go(-1),
			Escape: () => onfinish(false)
		};
		const action = keys[e.key];
		if (!action) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		action();
	}

	onMount(() => {
		void show(0);
		window.addEventListener('keydown', onkey, { capture: true });
		const still = (e: Event) => e.preventDefault();
		window.addEventListener('wheel', still, { passive: false, capture: true });
		window.addEventListener('touchmove', still, { passive: false, capture: true });
		const resize = () => {
			void measure();
		};
		window.addEventListener('resize', resize);
		return () => {
			window.removeEventListener('resize', resize);
			window.removeEventListener('keydown', onkey, { capture: true });
			window.removeEventListener('wheel', still, { capture: true });
			window.removeEventListener('touchmove', still, { capture: true });
		};
	});
</script>

<dialog
	class="gh tour"
	bind:this={layerEl}
	aria-labelledby="tour-title"
	oncancel={(e) => e.preventDefault()}
>
	<div class="blur" bind:this={blurEl}></div>
	<div class="ring" bind:this={ringEl}></div>
	<div class="card" bind:this={cardEl}>
		<span class="pip"><Pip pose={beat.pose} size={48} /></span>
		<div class="body" bind:this={bodyEl}>
			<p class="title" id="tour-title">{beat.title}</p>
			<p class="text">{beat.text}</p>
			{#if beat.id === 'ssh'}
				<code class="cmd gh-mono">orchard sandbox ssh-config --install</code>
			{:else if beat.id === 'context'}
				<code class="cmd gh-mono">orchard claude import</code>
			{/if}
		</div>
		<div class="foot">
			<span class="dots" aria-label="Step {shownIndex + 1} of {TOUR_BEATS.length}">
				{#each TOUR_BEATS as b, i (b.id)}
					<span class="dot" class:dot--on={i === shownIndex} class:dot--seen={i < shownIndex}
					></span>
				{/each}
			</span>
			{#if shownIndex > 0}
				<button type="button" class="gh-ibtn" aria-label="Back" title="Back" onclick={() => go(-1)}>
					<ArrowLeft size={16} strokeWidth={1.75} />
				</button>
			{/if}
			<button type="button" class="gh-btn gh-btn--primary" onclick={() => go(1)}>
				{last ? 'Start building' : shownIndex === 0 ? 'Show me' : 'Next'}
			</button>
		</div>
		{#if !last}
			<button type="button" class="skip" onclick={() => onfinish(false)}>Skip tour</button>
		{/if}
	</div>
</dialog>

<style>
	.tour {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		overflow: visible;
		border: none;
		background: transparent;
		color: var(--gh-text);
	}

	.tour::backdrop {
		background: transparent;
	}

	.blur {
		position: absolute;
		inset: 0;
		background: color-mix(in oklab, var(--bg-app) 45%, transparent);
		backdrop-filter: blur(10px) saturate(0.9);
	}

	.ring {
		position: absolute;
		border-radius: 0.75rem;
		box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 45%, transparent);
		pointer-events: none;
	}

	.card {
		position: fixed;
		inset: auto;
		width: 340px;
		max-width: calc(100vw - 2rem);
		max-height: none;
		margin: 0;
		padding: 1rem;
		overflow: visible;
		border: 1px solid var(--border-default);
		border-radius: 0.875rem;
		background: var(--bg-raised);
		box-shadow: var(--elev-3, 0 12px 32px rgb(0 0 0 / 0.18));
		color: var(--gh-text);
	}

	.pip {
		display: inline-grid;
		margin: -2.5rem 0 0.25rem;
	}

	.title {
		margin: 0 0 0.25rem;
		font-weight: 600;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
	}

	.text {
		margin: 0;
		font-size: var(--gh-ui, 0.8125rem);
		line-height: 1.25rem;
		color: var(--gh-muted);
	}

	.cmd {
		display: block;
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--fill-soft);
		font-size: 0.75rem;
		line-height: 1rem;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.dots {
		display: flex;
		flex: 1;
		gap: 0.25rem;
	}

	.dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 999px;
		background: var(--fill-soft);
	}

	.dot--seen {
		background: color-mix(in oklab, var(--accent) 35%, transparent);
	}

	.dot--on {
		width: 1rem;
		background: var(--accent);
	}

	.skip {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.skip:hover {
		color: var(--gh-text);
	}
</style>
