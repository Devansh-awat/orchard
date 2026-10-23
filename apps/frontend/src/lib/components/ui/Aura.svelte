<script lang="ts" module>
	const PALETTES = [
		['red', 'amber', 'accent'],
		['blue', 'green', 'blue'],
		['green', 'blue', 'green'],
		['amber', 'red', 'amber'],
		['blue', 'accent', 'blue'],
		['accent', 'amber', 'red']
	] as const;

	export function auraColors(name: string): string[] {
		const h = [...name].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
		const [a, b, c] = PALETTES[h % PALETTES.length];
		return [`var(--${a}-6)`, `var(--${b}-5)`, `var(--${c}-7)`, `var(--${b}-6)`, `var(--${a}-4)`];
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { effectiveAnimation } from '$lib/stores/preferences';
	import { createRenderer, loadPalette, renderStill } from '$lib/components/aura/aura';

	let {
		src = undefined,
		name = undefined,
		colors = undefined,
		seed = 0,
		still = false,
		class: className = ''
	}: {
		src?: string | null;
		name?: string;
		colors?: string[];
		seed?: number;
		still?: boolean;
		class?: string;
	} = $props();

	let host = $state<HTMLElement>();
	let canvas = $state<HTMLCanvasElement>();
	let image = $state<string | null>(null);
	let ready = $state(false);

	function resolve(list: string[]): string[] {
		if (!host) return list;
		const probe = document.createElement('span');
		host.appendChild(probe);
		const out = list.map((c) => {
			probe.style.color = c;
			return getComputedStyle(probe).color;
		});
		probe.remove();
		return out;
	}

	function source() {
		const list = colors ?? (name ? auraColors(name) : auraColors('orchard'));
		return { src, colors: resolve(list), seed };
	}

	onMount(() => {
		if (!host) return;
		const el = host;

		if (still) {
			const rect = el.getBoundingClientRect();
			const w = Math.max(1, Math.round(Math.min(rect.width, 960) / 2));
			const h = Math.max(1, Math.round((rect.height / Math.max(rect.width, 1)) * w));
			renderStill(source(), w, h).then((url) => {
				image = url;
				requestAnimationFrame(() => (ready = true));
			});
			return;
		}

		if (!canvas) return;
		const renderer = createRenderer(canvas);
		if (!renderer) return;

		let raf = 0;
		let last = 0;
		let time = 0;
		let visible = true;
		let moving = true;
		let alive = true;

		const size = () => {
			const r = el.getBoundingClientRect();
			renderer.resize(Math.max(1, Math.round(r.width / 2)), Math.max(1, Math.round(r.height / 2)));
			renderer.render(time, seed);
		};

		const frame = (now: number) => {
			raf = 0;
			if (!alive) return;
			const dt = last ? Math.min(now - last, 100) : 0;
			if (dt >= 33 || !last) {
				time += dt / 1000;
				last = now;
				renderer.render(time, seed);
			}
			if (visible && moving && !document.hidden) raf = requestAnimationFrame(frame);
		};

		const play = () => {
			if (!raf && visible && moving && !document.hidden) {
				last = 0;
				raf = requestAnimationFrame(frame);
			}
		};

		loadPalette(source()).then((palette) => {
			if (!alive || !palette) return;
			renderer.setPalette(palette);
			size();
			ready = true;
			play();
		});

		const ro = new ResizeObserver(size);
		ro.observe(el);
		const io = new IntersectionObserver((entries) => {
			visible = entries.some((e) => e.isIntersecting);
			play();
		});
		io.observe(el);
		const onVisibility = () => play();
		document.addEventListener('visibilitychange', onVisibility);
		const unsub = effectiveAnimation.subscribe((level) => {
			moving = level === 'full';
			play();
		});

		return () => {
			alive = false;
			cancelAnimationFrame(raf);
			ro.disconnect();
			io.disconnect();
			unsub();
			document.removeEventListener('visibilitychange', onVisibility);
			renderer.destroy();
		};
	});
</script>

<div
	bind:this={host}
	class="aura {className}"
	class:aura--ready={ready}
	aria-hidden="true"
	style:background-image={image ? `url("${image}")` : undefined}
>
	{#if !still}<canvas bind:this={canvas}></canvas>{/if}
</div>

<style>
	.aura {
		position: relative;
		overflow: hidden;
		background-color: var(--bg-active);
		background-size: cover;
		background-position: center;
	}
	.aura::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--bg-active);
		transition: opacity 600ms ease;
	}
	.aura--ready::after {
		opacity: 0;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
</style>
