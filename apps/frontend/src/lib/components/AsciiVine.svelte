<script lang="ts">
	import { onMount } from 'svelte';

	let {
		class: className = '',
		tone = 'dark',
		seed = 7,
		band = [0.3, 0.75]
	}: {
		class?: string;
		tone?: 'dark' | 'light';
		seed?: number;
		band?: [number, number];
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);

	const RAMP = ' ·.:;+*&%@';
	const CELL = 14;
	const STEP = CELL * 0.55;
	const FPS = 14;
	const PETALS = 5;
	const GROW = 3.5;

	const PALETTES = {
		dark: {
			stem: [232, 116, 133],
			stemAlpha: 0.58,
			leaf: 'rgba(232, 116, 133, 0.45)',
			tiers: [
				[201, 58, 79],
				[232, 116, 133],
				[243, 168, 178]
			],
			alpha: (v: number) => 0.3 + v * 0.6
		},
		light: {
			stem: [201, 58, 79],
			stemAlpha: 0.4,
			leaf: 'rgba(201, 58, 79, 0.32)',
			tiers: [
				[232, 116, 133],
				[201, 58, 79],
				[146, 28, 45]
			],
			alpha: (v: number) => 0.2 + v * 0.55
		}
	};

	function mulberry32(a: number) {
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	type Cell = { x: number; y: number; ch: string };
	type Segment = { cells: Cell[]; startAt: number; depth: number };
	type Leaf = { x: number; y: number; ch: string; at: number };
	type Bloom = { x: number; y: number; radius: number; at: number; phase: number; dir: number };

	onMount(() => {
		if (!canvas) return;
		const el = canvas;
		const ctx = el.getContext('2d');
		if (!ctx) return;

		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const palette = PALETTES[tone];
		let raf = 0;
		let running = false;
		let last = 0;
		let t = 0;
		let grown = 0;
		let totalGrow = 0;

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
			const w = el.width;
			const h = el.height;
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
				const cells: Cell[] = [];
				segments.push({ cells, startAt: at, depth: 1 });
				const curl = (rng() - 0.5) * 0.22;
				for (let i = 0; i < steps; i++) {
					heading += curl + (rng() - 0.5) * 0.09;
					x += Math.cos(heading) * STEP;
					y += Math.sin(heading) * STEP;
					if (x < CELL || x > w - CELL || y < CELL || y > h - CELL) break;
					cells.push({ x, y, ch: charFor(heading) });
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
		};

		const resize = () => {
			const rect = el.getBoundingClientRect();
			el.width = Math.ceil(rect.width);
			el.height = Math.ceil(rect.height);
			build();
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
					const tier = palette.tiers[v > 0.55 ? 2 : v > 0.28 ? 1 : 0];
					ctx.fillStyle = `rgba(${tier[0]}, ${tier[1]}, ${tier[2]}, ${palette.alpha(v)})`;
					ctx.fillText(RAMP[idx], c * CELL, r * CELL);
				}
			}
		};

		const draw = () => {
			ctx.clearRect(0, 0, el.width, el.height);
			ctx.font = '11px "Space Mono", monospace';
			ctx.textBaseline = 'top';

			const done = grown >= totalGrow;
			const sway = (x: number) => (done ? Math.sin(t * 0.7 + x * 0.018) * 1.5 : 0);
			const [sr, sg, sb] = palette.stem;

			for (const seg of segments) {
				const visible = Math.max(0, Math.min(seg.cells.length, Math.floor(grown - seg.startAt)));
				if (visible === 0) continue;
				ctx.fillStyle = `rgba(${sr}, ${sg}, ${sb}, ${palette.stemAlpha * (seg.depth > 0 ? 0.85 : 1)})`;
				for (let i = 0; i < visible; i++) {
					const cell = seg.cells[i];
					ctx.fillText(cell.ch, cell.x, cell.y + sway(cell.x));
				}
				if (visible < seg.cells.length) {
					const tip = seg.cells[visible - 1];
					ctx.fillText('*', tip.x, tip.y);
				}
			}

			ctx.fillStyle = palette.leaf;
			for (const leaf of leaves) {
				if (leaf.at >= grown) continue;
				ctx.fillText(leaf.ch, leaf.x, leaf.y + sway(leaf.x));
			}

			for (const b of flowers) {
				const a = Math.max(0, Math.min(1, (grown - b.at) / 30));
				if (a === 0) continue;
				const e = 1 - (1 - a) * (1 - a);
				drawBloom(b, e * (1 + 0.12 * Math.sin(e * Math.PI)));
			}
		};

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (now - last < 1000 / FPS) return;
			last = now;
			t += 0.08;
			grown += GROW;
			draw();
		};

		resize();

		if (reduce) {
			grown = totalGrow + 60;
			draw();
			const ro = new ResizeObserver(() => {
				resize();
				grown = totalGrow + 60;
				draw();
			});
			ro.observe(el);
			return () => ro.disconnect();
		}

		draw();

		const start = () => {
			if (running) return;
			running = true;
			raf = requestAnimationFrame(tick);
		};
		const stop = () => {
			running = false;
			cancelAnimationFrame(raf);
		};

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
			draw();
		});
		ro.observe(el);

		return () => {
			stop();
			io.disconnect();
			ro.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<canvas bind:this={canvas} class={className} aria-hidden="true"></canvas>
