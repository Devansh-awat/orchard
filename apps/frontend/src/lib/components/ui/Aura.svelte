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

	export function resolveColors(host: Element, list: string[]): string[] {
		const probe = document.createElement('span');
		host.appendChild(probe);
		const out = list.map((c) => {
			probe.style.color = c;
			return getComputedStyle(probe).color;
		});
		probe.remove();
		return out;
	}
</script>

<script lang="ts">
	import { ambientHeld } from '$lib/utils/motion.svelte';
	import { onMount } from 'svelte';
	import { effectiveAnimation } from '$lib/stores/preferences';
	import { colorsImage, createRenderer, loadTexture } from '$lib/components/aura/aura';

	let {
		src = undefined,
		name = 'orchard',
		class: className = ''
	}: {
		src?: string | null;
		name?: string;
		class?: string;
	} = $props();

	let host = $state<HTMLElement>();
	let canvas = $state<HTMLCanvasElement>();
	let ready = $state(false);

	onMount(() => {
		if (!host || !canvas) return;
		const el = host;
		const renderer = createRenderer(canvas);
		if (!renderer) return;

		let raf = 0;
		let last = 0;
		let frame = 0;
		let visible = true;
		let moving = true;
		let alive = true;

		const size = () => {
			const r = el.getBoundingClientRect();
			renderer.resize(Math.max(1, Math.round(r.width / 2)), Math.max(1, Math.round(r.height / 2)));
			renderer.render(frame);
		};

		const tick = (now: number) => {
			raf = 0;
			if (!alive) return;
			const dt = last ? Math.min(now - last, 100) : 0;
			if (!ambientHeld() && (dt >= 33 || !last)) {
				frame += (dt / 1000) * 60;
				last = now;
				renderer.render(frame);
			}
			if (visible && moving && !document.hidden) raf = requestAnimationFrame(tick);
		};

		const play = () => {
			if (!raf && ready && visible && moving && !document.hidden) {
				last = 0;
				raf = requestAnimationFrame(tick);
			}
		};

		const source = src || colorsImage(resolveColors(el, auraColors(name)));
		if (source) {
			loadTexture(source).then((img) => {
				if (!alive || !img) return;
				renderer.setImage(img);
				size();
				ready = true;
				play();
			});
		}

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

<div bind:this={host} class="aura {className}" class:aura--ready={ready} aria-hidden="true">
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.aura {
		position: relative;
		overflow: hidden;
		background-color: var(--bg-active);
	}
	.aura::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--bg-active);
		transition: opacity 700ms ease;
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
