<script lang="ts">
	import { onMount } from 'svelte';
	import { decorativeMotion } from '$lib/utils/motion.svelte';

	let {
		class: className = '',
		seed = 7,
		band = [0.3, 0.75],
		bloom = false
	}: {
		class?: string;
		seed?: number;
		band?: [number, number];
		bloom?: boolean;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let blooming = false;
	let onBloom: (() => void) | null = null;

	$effect(() => {
		if (bloom && !blooming) {
			blooming = true;
			onBloom?.();
		}
		if (!bloom) blooming = false;
	});

	const RAMP = ' ·.:;+*&%@';
	const CELL = 14;
	const STEP = CELL * 0.55;
	const FPS = 14;
	const PETALS = 5;
	const GROW = 3.5;
	const BLOOM_TICKS = 9;
	const INKS = ['--vine-stem', '--vine-leaf', '--vine-petal-1', '--vine-petal-2', '--vine-petal-3'];

	type Rgb = [number, number, number];

	function mulberry32(seed: number) {
		let a = seed | 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function readInks(el: HTMLElement): Rgb[] {
		const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
		const inks = INKS.map((name): Rgb => {
			if (!probe) return [128, 128, 128];
			el.style.color = `var(${name})`;
			probe.clearRect(0, 0, 1, 1);
			probe.fillStyle = getComputedStyle(el).color;
			probe.fillRect(0, 0, 1, 1);
			const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
			return [r, g, b];
		});
		el.style.color = '';
		return inks;
	}

	type Cell = { x: number; y: number; ch: string };
	type Segment = { cells: Cell[]; startAt: number; depth: number };
	type Leaf = { x: number; y: number; ch: string; at: number };
	type Bloom = {
		x: number;
		y: number;
		radius: number;
		at: number;
		phase: number;
		dir: number;
		late?: boolean;
	};

	onMount(() => {
		if (!canvas) return;
		const el = canvas;
		const ctx = el.getContext('2d');
		if (!ctx) return;

		let inks = readInks(el);
		let font = '11px monospace';
		let raf = 0;
		let running = false;
		let last = 0;
		let t = 0;
		let grown = 0;
		let totalGrow = 0;
		let burst = -1;
		let w = 0;
		let h = 0;

		let segments: Segment[] = [];
		let leaves: Leaf[] = [];
		let flowers: Bloom[] = [];

		const charFor = (heading: number) => {
			const dx = Math.cos(heading);
			const dy = Math.sin(heading);
			if (Math.abs(dy) < 0.38 * Math.abs(dx)) return '~';
			if (Math.abs(dx) < 0.38 * Math.abs(dy)) return '|';
			return dx * dy > 0 ? '\\' : '/';
		};

		const build = () => {
			const rng = mulberry32(seed);
			segments = [];
			leaves = [];
			flowers = [];
			totalGrow = 0;

			const yMin = band[0] * h;
			const yMax = band[1] * h;
			const cy = (yMin + yMax) / 2;
			const a1 = (yMax - yMin) * 0.42;
			const a2 = a1 * 0.45;
			const f1 = (0.07 + rng() * 0.04) / CELL;
			const f2 = (0.19 + rng() * 0.07) / CELL;
			const p1 = rng() * Math.PI * 2;
			const p2 = rng() * Math.PI * 2;
			const yAt = (x: number) => cy + a1 * Math.sin(x * f1 + p1) + a2 * Math.sin(x * f2 + p2);
			const bloomScale = Math.min(1, Math.max(0.6, h / (CELL * 22)));

			const stem: Cell[] = [];
			const endX = w - Math.min(CELL * 7, w * 0.06);
			for (let x = -CELL; x <= endX; x += STEP) {
				const y = yAt(x);
				const slope = (yAt(x + STEP) - y) / STEP;
				stem.push({ x, y, ch: charFor(Math.atan2(slope, 1)) });
			}
			segments.push({ cells: stem, startAt: 0, depth: 0 });
			totalGrow = stem.length;

			const branch = (at: number, heading: number, steps: number) => {
				let { x, y } = stem[at];
				let dir = heading;
				const cells: Cell[] = [];
				segments.push({ cells, startAt: at, depth: 1 });
				const curl = (rng() - 0.5) * 0.22;
				for (let i = 0; i < steps; i++) {
					dir += curl + (rng() - 0.5) * 0.09;
					x += Math.cos(dir) * STEP;
					y += Math.sin(dir) * STEP;
					if (x < CELL || x > w - CELL || y < CELL || y > h - CELL) break;
					cells.push({ x, y, ch: charFor(dir) });
				}
				totalGrow = Math.max(totalGrow, at + cells.length);
				const tip = cells[cells.length - 1];
				if (tip && rng() < 0.85) {
					flowers.push({
						x: tip.x,
						y: tip.y,
						radius: (2.5 + rng() * 2.5) * bloomScale,
						at: at + cells.length + 3,
						phase: rng() * Math.PI * 2,
						dir: rng() > 0.5 ? 1 : -1
					});
				}
			};

			let side = rng() > 0.5 ? 1 : -1;
			let nextBranch = 8 + Math.floor(rng() * 10);
			let nextLeaf = 5 + Math.floor(rng() * 6);
			for (let i = 0; i < stem.length; i++) {
				if (i === nextLeaf) {
					leaves.push({
						x: stem[i].x,
						y: stem[i].y + side * CELL * 0.8,
						ch: side < 0 ? "'" : ',',
						at: i
					});
					side = -side;
					nextLeaf = i + 6 + Math.floor(rng() * 8);
				}
				if (i === nextBranch && i < stem.length - 6) {
					const tangent = Math.atan2(stem[i + 1].y - stem[i].y, stem[i + 1].x - stem[i].x);
					branch(i, tangent + side * (0.6 + rng() * 0.55), 5 + Math.floor(rng() * 12));
					side = -side;
					nextBranch = i + 10 + Math.floor(rng() * 14);
				}
			}

			const tip = stem[stem.length - 1];
			flowers.push({
				x: tip.x,
				y: tip.y - CELL * 0.5,
				radius: (4.5 + rng() * 1.5) * bloomScale,
				at: stem.length + 4,
				phase: rng() * Math.PI * 2,
				dir: rng() > 0.5 ? 1 : -1
			});

			for (const leaf of leaves) {
				if (rng() < 0.55) continue;
				flowers.push({
					x: leaf.x,
					y: leaf.y,
					radius: (1.6 + rng() * 1.4) * bloomScale,
					at: Infinity,
					phase: rng() * Math.PI * 2,
					dir: rng() > 0.5 ? 1 : -1,
					late: true
				});
			}
		};

		const resize = () => {
			const rect = el.getBoundingClientRect();
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			w = Math.ceil(rect.width);
			h = Math.ceil(rect.height);
			el.width = Math.ceil(w * dpr);
			el.height = Math.ceil(h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			font = `11px ${getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'monospace'}`;
			build();
			if (burst >= 0) for (const f of flowers) if (f.late) f.at = 0;
		};

		const ink = (i: number, alpha: number) => {
			const [r, g, b] = inks[i];
			ctx.fillStyle = `rgb(${r} ${g} ${b})`;
			ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
		};

		const drawBloom = (b: Bloom, scale: number) => {
			const maxR = b.radius * scale;
			if (maxR < 0.8) return;
			const c0 = Math.round(b.x / CELL);
			const r0 = Math.round(b.y / CELL);
			const rot = t * 0.14 * b.dir + b.phase;
			const span = Math.ceil(maxR * 1.1);
			for (let r = r0 - span; r <= r0 + span; r++) {
				for (let c = c0 - span; c <= c0 + span; c++) {
					const dx = c - c0;
					const dy = (r - r0) * 1.15;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist > maxR * 1.05) continue;
					const theta = Math.atan2(dy, dx);
					const petal = Math.cos(PETALS * theta + rot);
					const shape = maxR * (0.18 + 0.82 * Math.pow(Math.abs(petal), 0.9));
					let v = 1 - dist / shape;
					if (v <= 0) continue;
					v = Math.min(1, v * 1.2);
					v *= 0.92 + 0.08 * Math.sin(dist * 0.7 - t * 1.4 + petal * 2);
					const idx = Math.min(RAMP.length - 1, Math.max(1, Math.ceil(v * (RAMP.length - 1))));
					ink(v > 0.55 ? 4 : v > 0.28 ? 3 : 2, 0.28 + v * 0.62);
					ctx.fillText(RAMP[idx], c * CELL, r * CELL);
				}
			}
		};

		const draw = () => {
			ctx.clearRect(0, 0, w, h);
			ctx.font = font;
			ctx.textBaseline = 'top';

			const done = grown >= totalGrow;
			const sway = (x: number) => (done ? Math.sin(t * 0.7 + x * 0.018) * 1.5 : 0);
			const boost = burst < 0 ? 0 : Math.min(1, (t - burst) / (BLOOM_TICKS * 0.08));

			for (const seg of segments) {
				const visible = Math.max(0, Math.min(seg.cells.length, Math.floor(grown - seg.startAt)));
				if (visible === 0) continue;
				ink(0, (seg.depth > 0 ? 0.5 : 0.6) + boost * 0.15);
				for (let i = 0; i < visible; i++) {
					const cell = seg.cells[i];
					ctx.fillText(cell.ch, cell.x, cell.y + sway(cell.x));
				}
				if (visible < seg.cells.length) {
					const tip = seg.cells[visible - 1];
					ctx.fillText('*', tip.x, tip.y);
				}
			}

			ink(1, 0.5);
			for (const leaf of leaves) {
				if (leaf.at >= grown) continue;
				ctx.fillText(leaf.ch, leaf.x, leaf.y + sway(leaf.x));
			}

			for (const b of flowers) {
				const a = Math.max(0, Math.min(1, (grown - b.at) / 30));
				if (a === 0) continue;
				const e = 1 - (1 - a) * (1 - a);
				const lift = b.late ? 1 : 1 + 0.3 * Math.sin(boost * Math.PI) + 0.12 * boost;
				drawBloom(b, e * (1 + 0.12 * Math.sin(e * Math.PI)) * lift);
			}
			ctx.globalAlpha = 1;
		};

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (now - last < 1000 / FPS) return;
			last = now;
			t += 0.08;
			grown += burst >= 0 ? GROW * 3 : GROW;
			draw();
		};

		const start = () => {
			if (running || !decorativeMotion()) return;
			running = true;
			raf = requestAnimationFrame(tick);
		};
		const stop = () => {
			running = false;
			cancelAnimationFrame(raf);
		};

		const settle = () => {
			grown = Math.max(grown, totalGrow + 60);
		};

		onBloom = () => {
			if (!decorativeMotion()) {
				for (const f of flowers) if (f.late) f.at = -60;
				settle();
				draw();
				return;
			}
			if (grown < totalGrow) grown = totalGrow;
			for (const f of flowers) if (f.late) f.at = grown;
			burst = t;
			start();
		};

		resize();
		if (!decorativeMotion()) settle();
		draw();

		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting) && !document.hidden) start();
			else stop();
		});
		io.observe(el);

		const onVisibility = () => {
			if (document.hidden) stop();
			else start();
		};
		document.addEventListener('visibilitychange', onVisibility);

		const ro = new ResizeObserver(() => {
			resize();
			if (!decorativeMotion()) settle();
			draw();
		});
		ro.observe(el);

		const theme = new MutationObserver(() => {
			inks = readInks(el);
			draw();
		});
		theme.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style', 'data-theme', 'data-look']
		});

		return () => {
			stop();
			onBloom = null;
			io.disconnect();
			ro.disconnect();
			theme.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<canvas bind:this={canvas} class="vine {className}" aria-hidden="true"></canvas>

<style>
	.vine {
		--vine-stem: var(--accent-8);
		--vine-leaf: var(--accent-7);
		--vine-petal-1: var(--accent-6);
		--vine-petal-2: var(--accent-8);
		--vine-petal-3: var(--accent-10);
		display: block;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
</style>
