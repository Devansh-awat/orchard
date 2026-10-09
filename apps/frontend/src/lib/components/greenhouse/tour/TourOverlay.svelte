<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { animate } from 'motion';
	import { ArrowLeft } from 'lucide-svelte';
	import { motion, transition } from '$lib/utils/motion.svelte';
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
	const GAP = 16;
	const CARD_W = 340;

	let index = $state(0);
	let busy = $state(false);
	type Box = { x: number; y: number; w: number; h: number };
	const RADIUS = 12;

	let hole: Box | null = null;
	let shown: Box | null = null;
	let blurEl = $state<HTMLDivElement | null>(null);
	let ringEl = $state<HTMLDivElement | null>(null);
	let moving: { stop: () => void } | null = null;
	let cardEl = $state<HTMLDivElement | null>(null);
	let cardPos = $state<{ left: number; top: number } | null>(null);
	let run = 0;

	const beat = $derived(TOUR_BEATS[index]);
	const last = $derived(index === TOUR_BEATS.length - 1);

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function find(selector: string, timeout = 3000): Promise<HTMLElement | null> {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			const el = document.querySelector<HTMLElement>(selector);
			if (el) {
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) return el;
			}
			await sleep(50);
		}
		return null;
	}

	async function step(s: TourStep) {
		if (s.kind === 'session') {
			onsession(s.id);
			await sleep(400);
		} else if (s.kind === 'escape') {
			for (const el of document.querySelectorAll<HTMLElement>('[popover]:popover-open')) {
				if (el !== cardEl) el.hidePopover();
			}
			document.querySelector<HTMLElement>('dialog[open] [aria-label="Close"]')?.click();
			await sleep(250);
		} else {
			const el = await find(s.selector);
			el?.click();
			await sleep(350);
		}
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

	function place(r: { x: number; y: number; w: number; h: number } | null) {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const ch = cardEl?.offsetHeight ?? 220;
		if (!r) return { left: (vw - CARD_W) / 2, top: Math.max(GAP, (vh - ch) / 2) };
		const clampTop = (top: number) => Math.min(Math.max(GAP, top), vh - ch - GAP);
		if (r.x + r.w + GAP + CARD_W <= vw - GAP) return { left: r.x + r.w + GAP, top: clampTop(r.y) };
		if (r.x - GAP - CARD_W >= GAP) return { left: r.x - GAP - CARD_W, top: clampTop(r.y) };
		const left = Math.min(Math.max(GAP, r.x), vw - CARD_W - GAP);
		if (r.y + r.h + GAP + ch <= vh - GAP) return { left, top: r.y + r.h + GAP };
		return { left, top: Math.max(GAP, r.y - GAP - ch) };
	}

	async function measure() {
		const target = beat.target ? await find(beat.target) : null;
		if (!target) {
			hole = null;
		} else {
			const r = target.getBoundingClientRect();
			hole = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
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
			...transition('smooth'),
			onUpdate: (t) =>
				paint({
					x: from.x + (box.x - from.x) * t,
					y: from.y + (box.y - from.y) * t,
					w: from.w + (box.w - from.w) * t,
					h: from.h + (box.h - from.h) * t
				})
		});
		if (!shown) paint(box);
		await tick();
		cardPos = place(hole);
		await tick();
		if (cardEl) {
			if (cardEl.matches(':popover-open')) cardEl.hidePopover();
			cardEl.showPopover();
			motion(cardEl, { opacity: [0, 1], y: [6, 0] }, 'snappy');
			cardEl.querySelector<HTMLButtonElement>('.gh-btn--primary')?.focus({ preventScroll: true });
		}
	}

	async function show(next: number) {
		const mine = ++run;
		busy = true;
		index = next;
		for (const s of TOUR_BEATS[next].before ?? []) {
			if (mine !== run) return;
			await step(s);
		}
		if (mine !== run) return;
		await measure();
		busy = false;
	}

	function go(delta: number) {
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
		if (!busy) action();
	}

	onMount(() => {
		void show(0);
		window.addEventListener('keydown', onkey, { capture: true });
		const resize = () => {
			void measure();
		};
		window.addEventListener('resize', resize);
		return () => {
			window.removeEventListener('resize', resize);
			window.removeEventListener('keydown', onkey, { capture: true });
		};
	});
</script>

<div class="gh tour" role="presentation">
	<div class="blur" bind:this={blurEl}></div>
	<div class="ring" bind:this={ringEl}></div>
</div>

<div
	class="gh card"
	popover="manual"
	bind:this={cardEl}
	role="dialog"
	aria-modal="true"
	aria-labelledby="tour-title"
	style={cardPos ? `left: ${cardPos.left}px; top: ${cardPos.top}px` : ''}
>
	<span class="pip"><Pip pose={beat.pose} size={48} /></span>
	<p class="title" id="tour-title">{beat.title}</p>
	<p class="text">{beat.text}</p>
	{#if beat.id === 'ssh'}
		<code class="cmd gh-mono">orchard sandbox ssh-config --install</code>
	{:else if beat.id === 'context'}
		<code class="cmd gh-mono">orchard claude import</code>
	{/if}
	<div class="foot">
		<span class="dots" aria-label="Step {index + 1} of {TOUR_BEATS.length}">
			{#each TOUR_BEATS as b, i (b.id)}
				<span class="dot" class:dot--on={i === index} class:dot--seen={i < index}></span>
			{/each}
		</span>
		{#if index > 0}
			<button
				type="button"
				class="gh-ibtn"
				aria-label="Back"
				title="Back"
				disabled={busy}
				onclick={() => go(-1)}
			>
				<ArrowLeft size={16} strokeWidth={1.75} />
			</button>
		{/if}
		<button type="button" class="gh-btn gh-btn--primary" disabled={busy} onclick={() => go(1)}>
			{last ? 'Start building' : index === 0 ? 'Show me' : 'Next'}
		</button>
	</div>
	{#if !last}
		<button type="button" class="skip" onclick={() => onfinish(false)}>Skip tour</button>
	{/if}
</div>

<style>
	.tour {
		position: fixed;
		inset: 0;
		z-index: 2147483000;
		pointer-events: auto;
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
