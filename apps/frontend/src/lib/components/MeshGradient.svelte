<script lang="ts">
	import { onMount } from 'svelte';
	import { effectiveAnimation } from '$lib/stores/preferences';

	let {
		src,
		class: className = '',
		size = 720,
		saturation = 0.95,
		blur = 22,
		shadowLift = 0.18
	}: {
		src: string;
		class?: string;
		size?: number;
		saturation?: number;
		blur?: number;
		shadowLift?: number;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let drift = $derived($effectiveAnimation === 'full');
	let setPlayState: (() => void) | null = null;

	$effect(() => {
		drift;
		setPlayState?.();
	});

	function textureUrl(raw: string): string {
		try {
			const u = new URL(raw, location.href);
			if (u.origin === location.origin) return u.href;
			return `/asset-proxy?u=${encodeURIComponent(u.href)}`;
		} catch {
			return raw;
		}
	}

	onMount(() => {
		let destroyed = false;
		let app: any = null;
		const cleanups: Array<() => void> = [];

		(async () => {
			if (!canvas || !src) return;

			const [pixi, filters] = await Promise.all([import('pixi.js'), import('pixi-filters')]);
			if (destroyed) return;
			const { Application, Assets, Sprite, Container, ColorMatrixFilter, Rectangle } = pixi;
			const { TwistFilter, KawaseBlurFilter } = filters;

			app = new Application();
			await app.init({
				canvas,
				width: size,
				height: size,
				backgroundAlpha: 0,
				antialias: false,
				powerPreference: 'low-power',
				autoStart: false,
				resolution: 1,
				preference: 'webgl'
			});
			if (destroyed) {
				app.destroy(false, { children: true, texture: true });
				app = null;
				return;
			}

			let texture: any;
			try {
				texture = await Assets.load({ src: textureUrl(src), parser: 'loadTextures' });
			} catch {
				return;
			}
			if (destroyed) return;

			const center = size / 2;
			const stage = new Container();

			const specs = [
				{ scale: 1.7, orbit: 0, spin: 0.0011, orbitSpeed: 0 },
				{ scale: 1.0, orbit: 0, spin: -0.0014, orbitSpeed: 0 },
				{ scale: 0.6, orbit: 0.16, spin: 0.0018, orbitSpeed: 0.011 },
				{ scale: 0.32, orbit: 0.22, spin: -0.0023, orbitSpeed: -0.009 }
			];
			const sprites = specs.map((spec, i) => {
				const sp = new Sprite(texture);
				sp.anchor.set(0.5);
				const dim = size * spec.scale;
				sp.width = dim;
				sp.height = dim;
				sp.x = center;
				sp.y = center;
				sp.rotation = (i / specs.length) * Math.PI * 2;
				stage.addChild(sp);
				return { sp, spec, phase: (i / specs.length) * Math.PI * 2 };
			});

			const colorMatrix = new ColorMatrixFilter();
			// Grade the gradient identically in both themes so the shader reads the
			// same regardless of light/dark mode.
			const grade = () => {
				colorMatrix.reset();
				colorMatrix.saturate(saturation, true);
			};
			grade();
			const twist = new TwistFilter({
				radius: size * 0.62,
				angle: 3.2,
				offset: { x: center, y: center },
				padding: 0
			});
			const kawase = new KawaseBlurFilter({ strength: blur, quality: 5, clamp: true });

			stage.filters = [colorMatrix, twist, kawase];
			stage.filterArea = new Rectangle(0, 0, size, size);
			app.stage.addChild(stage);

			let t = 0;
			const tick = () => {
				t += app.ticker.deltaTime;
				for (const { sp, spec, phase } of sprites) {
					sp.rotation += spec.spin * app.ticker.deltaTime;
					if (spec.orbit > 0) {
						const r = size * spec.orbit;
						const a = t * spec.orbitSpeed + phase;
						sp.x = center + Math.cos(a) * r;
						sp.y = center + Math.sin(a) * r;
					}
				}
			};

			app.ticker.maxFPS = 15;
			app.ticker.add(tick);
			app.render();

			let onScreen = true;
			const updatePlayState = () => {
				if (!app) return;
				if (drift && onScreen && !document.hidden) app.start();
				else app.stop();
			};
			setPlayState = updatePlayState;
			cleanups.push(() => {
				setPlayState = null;
			});

			const io = new IntersectionObserver((entries) => {
				onScreen = entries.some((e) => e.isIntersecting);
				updatePlayState();
			});
			io.observe(canvas);
			cleanups.push(() => io.disconnect());

			const onVisibility = () => updatePlayState();
			document.addEventListener('visibilitychange', onVisibility);
			cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

			updatePlayState();
		})();

		return () => {
			destroyed = true;
			cleanups.forEach((fn) => fn());
			if (app) {
				app.destroy(false, { children: true, texture: true });
				app = null;
			}
		};
	});
</script>

<canvas bind:this={canvas} class={className} aria-hidden="true"></canvas>

<style>
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
