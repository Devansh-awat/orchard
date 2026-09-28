<script lang="ts">
	import { onMount } from 'svelte';

	let {
		class: className = '',
		seed = 19,
		max = 6
	}: { class?: string; seed?: number; max?: number } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let plant = $state<(x: number, y: number) => void>(() => {});

	const RAMP = ' ·.:;+*&%@';
	const CELL = 14;
	const STEP = CELL * 0.55;
	const FPS = 14;
	const PETALS = 5;
	const GROW = 3.5;

	const STEM = [255, 255, 248];
	const LEAF = 'rgba(255, 223, 227, 0.75)';
	const TIERS = [
		[255, 173, 189],
		[255, 223, 227],
		[255, 255, 255]
	];

	type Cell = { x: number; y: number; ch: string };
	type Segment = { cells: Cell[]; at: number; depth: number };
	type Leaf = { x: number; y: number; ch: string; at: number };
	type Bloom = { x: number; y: number; radius: number; at: number; phase: number; dir: number };
	type Vine = {
		segments: Segment[];
		leaves: Leaf[];
		blooms: Bloom[];
		total: number;
		grown: number;
		fade: number;
	};

	function mulberry32(value: number) {
		let a = value | 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function charFor(heading: number) {
		const dx = Math.cos(heading);
		const dy = Math.sin(heading);
		if (Math.abs(dy) < 0.38 * Math.abs(dx)) return '~';
		if (Math.abs(dx) < 0.38 * Math.abs(dy)) return '|';
		return dx * dy > 0 ? '\\' : '/';
	}

	export function grow() {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return;
		plant(rect.width * (0.1 + Math.random() * 0.8), rect.height * (0.2 + Math.random() * 0.6));
	}

	onMount(() => {
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext('2d');
		if (!ctx) return;

		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const rng = mulberry32(seed);
		let width = 0;
		let height = 0;
		let vines: Vine[] = [];
		let raf = 0;
		let running = false;
		let last = 0;
		let t = 0;

		const inside = (x: number, y: number) =>
			x > CELL * 0.5 && x < width - CELL && y > CELL && y < height - CELL * 2;

		const build = (x0: number, x1: number, cy: number, amp: number, bloomScale = 1): Vine => {
			const dir = x1 >= x0 ? 1 : -1;
			const segments: Segment[] = [];
			const leaves: Leaf[] = [];
			const blooms: Bloom[] = [];
			const f1 = (0.07 + rng() * 0.04) / CELL;
			const f2 = (0.19 + rng() * 0.07) / CELL;
			const p1 = rng() * Math.PI * 2;
			const p2 = rng() * Math.PI * 2;
			const floor = CELL * 1.5;
			const ceiling = height - CELL * 3;
			const yAt = (x: number) =>
				Math.min(
					ceiling,
					Math.max(floor, cy + amp * Math.sin(x * f1 + p1) + amp * 0.45 * Math.sin(x * f2 + p2))
				);

			const stem: Cell[] = [];
			for (let x = x0; dir * (x1 - x) >= 0; x += dir * STEP) {
				const y = yAt(x);
				const dy = yAt(x + dir * STEP) - y;
				stem.push({ x, y, ch: charFor(Math.atan2(dy, dir * STEP)) });
			}
			segments.push({ cells: stem, at: 0, depth: 0 });
			let total = stem.length;

			const branch = (at: number, heading: number, steps: number) => {
				let { x, y } = stem[at];
				let angle = heading;
				const cells: Cell[] = [];
				const curl = (rng() - 0.5) * 0.2;
				for (let i = 0; i < steps; i++) {
					angle += curl + (rng() - 0.5) * 0.09;
					x += Math.cos(angle) * STEP;
					y += Math.sin(angle) * STEP;
					if (!inside(x, y)) break;
					cells.push({ x, y, ch: charFor(angle) });
				}
				segments.push({ cells, at, depth: 1 });
				total = Math.max(total, at + cells.length);
				const tip = cells[cells.length - 1];
				if (tip && rng() < 0.9) {
					blooms.push({
						x: tip.x,
						y: tip.y,
						radius: (2.6 + rng() * 2.2) * bloomScale,
						at: at + cells.length + 3,
						phase: rng() * Math.PI * 2,
						dir: rng() > 0.5 ? 1 : -1
					});
				}
			};

			let side = rng() > 0.5 ? 1 : -1;
			let nextBranch = 7 + Math.floor(rng() * 8);
			let nextLeaf = 4 + Math.floor(rng() * 5);
			for (let i = 1; i < stem.length - 1; i++) {
				if (i === nextLeaf) {
					leaves.push({
						x: stem[i].x,
						y: stem[i].y + side * CELL * 0.8,
						ch: side < 0 ? "'" : ',',
						at: i
					});
					side = -side;
					nextLeaf = i + 5 + Math.floor(rng() * 7);
				}
				if (i === nextBranch && i < stem.length - 6) {
					const tangent = Math.atan2(stem[i + 1].y - stem[i - 1].y, stem[i + 1].x - stem[i - 1].x);
					branch(i, tangent + side * (0.95 + rng() * 0.45), 8 + Math.floor(rng() * 12));
					side = -side;
					nextBranch = i + 9 + Math.floor(rng() * 11);
				}
			}

			const tip = stem[stem.length - 1];
			if (tip) {
				blooms.push({
					x: tip.x,
					y: tip.y - CELL * 0.5,
					radius: (3.6 + rng() * 1.2) * bloomScale,
					at: stem.length + 4,
					phase: rng() * Math.PI * 2,
					dir: rng() > 0.5 ? 1 : -1
				});
			}
			return { segments, leaves, blooms, total: total + 34, grown: 0, fade: 1 };
		};

		const scaleFor = () => Math.min(1, Math.max(0.6, height / (CELL * 24)));

		const seedGarden = () => {
			const s = scaleFor();
			vines = [
				build(-CELL, width - CELL * 4, height * 0.4, height * 0.13, s),
				build(width + CELL, width * 0.3, height * 0.76, height * 0.06, s * 0.85)
			];
		};

		const resize = () => {
			const rect = el.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			width = Math.ceil(rect.width);
			height = Math.ceil(rect.height);
			el.width = width * dpr;
			el.height = height * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};

		const drawBloom = (b: Bloom, scale: number, alpha: number) => {
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
					const tier = TIERS[v > 0.55 ? 2 : v > 0.28 ? 1 : 0];
					ctx.fillStyle = `rgba(${tier[0]}, ${tier[1]}, ${tier[2]}, ${(0.4 + v * 0.6) * alpha})`;
					ctx.fillText(RAMP[idx], c * CELL, r * CELL);
				}
			}
		};

		const draw = () => {
			ctx.clearRect(0, 0, width, height);
			ctx.font = '12px "Space Mono", monospace';
			ctx.textBaseline = 'top';
			for (const vine of vines) {
				const done = vine.grown >= vine.total;
				const sway = (x: number) => (done ? Math.sin(t * 0.7 + x * 0.018) * 1.5 : 0);
				for (const seg of vine.segments) {
					const visible = Math.max(0, Math.min(seg.cells.length, Math.floor(vine.grown - seg.at)));
					if (visible === 0) continue;
					ctx.fillStyle = `rgba(${STEM[0]}, ${STEM[1]}, ${STEM[2]}, ${(seg.depth ? 0.6 : 0.72) * vine.fade})`;
					for (let i = 0; i < visible; i++) {
						const cell = seg.cells[i];
						ctx.fillText(cell.ch, cell.x, cell.y + sway(cell.x));
					}
					if (visible < seg.cells.length) {
						const tip = seg.cells[visible - 1];
						ctx.fillText('*', tip.x, tip.y);
					}
				}
				ctx.globalAlpha = vine.fade;
				ctx.fillStyle = LEAF;
				for (const leaf of vine.leaves) {
					if (leaf.at >= vine.grown) continue;
					ctx.fillText(leaf.ch, leaf.x, leaf.y + sway(leaf.x));
				}
				ctx.globalAlpha = 1;
				for (const b of vine.blooms) {
					const a = Math.max(0, Math.min(1, (vine.grown - b.at) / 30));
					if (a === 0) continue;
					const e = 1 - (1 - a) * (1 - a);
					drawBloom(b, e * (1 + 0.12 * Math.sin(e * Math.PI)), vine.fade);
				}
			}
		};

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (now - last < 1000 / FPS) return;
			last = now;
			t += 0.08;
			for (const vine of vines) vine.grown += GROW;
			const excess = vines.length - max;
			for (let i = 0; i < excess; i++) vines[i].fade *= 0.82;
			vines = vines.filter((v) => v.fade > 0.03);
			draw();
		};

		plant = (x: number, y: number) => {
			const toRight = x < width / 2;
			const reach = Math.min(width * 0.5, toRight ? width - x - CELL * 3 : x - CELL);
			const end = x + (toRight ? 1 : -1) * Math.max(reach, CELL * 8);
			const amp = Math.min(height * 0.09, y - CELL * 2, height - y - CELL * 3);
			const vine = build(x, end, y, Math.max(amp, CELL), scaleFor() * 0.9);
			if (reduce) vine.grown = vine.total;
			vines = [...vines, vine];
			if (reduce) {
				if (vines.length > max) vines = vines.slice(vines.length - max);
				draw();
			}
		};

		const onPointer = (e: PointerEvent) => {
			const rect = el.getBoundingClientRect();
			plant(e.clientX - rect.left, e.clientY - rect.top);
		};
		el.addEventListener('pointerdown', onPointer);

		resize();
		seedGarden();

		if (reduce) {
			for (const vine of vines) vine.grown = vine.total;
			draw();
			const ro = new ResizeObserver(() => {
				resize();
				seedGarden();
				for (const vine of vines) vine.grown = vine.total;
				draw();
			});
			ro.observe(el);
			return () => {
				ro.disconnect();
				el.removeEventListener('pointerdown', onPointer);
			};
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
		let lastWidth = width;
		const ro = new ResizeObserver(() => {
			resize();
			if (Math.abs(width - lastWidth) > 40) {
				lastWidth = width;
				seedGarden();
			}
			draw();
		});
		ro.observe(el);

		return () => {
			stop();
			io.disconnect();
			ro.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			el.removeEventListener('pointerdown', onPointer);
		};
	});
</script>

<canvas bind:this={canvas} class="cursor-pointer {className}" aria-hidden="true"></canvas>
