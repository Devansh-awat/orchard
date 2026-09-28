<script lang="ts">
	import { onMount } from 'svelte';
	import { MARK_VIEWBOX, MARK_RING, PETALS, petalBox } from '$lib/mark';
	import { prefersReduced, whileVisible } from '$lib/motion.svelte';

	let { class: className = '' }: { class?: string } = $props();

	let root = $state<HTMLElement | null>(null);

	onMount(() => {
		const el = root;
		if (!el || prefersReduced()) return;
		const sway = el.querySelector<HTMLElement>('[data-sway]');
		const band = el.querySelector<HTMLElement>('[data-depth-band]');
		const petals = Array.from(el.querySelectorAll<HTMLElement>('[data-depth-petal]'));

		let targetX = 0;
		let targetY = 0;
		let x = 0;
		let y = 0;
		let raf = 0;
		const born = performance.now();

		const onMove = (e: PointerEvent) => {
			targetX = (e.clientX / window.innerWidth) * 2 - 1;
			targetY = (e.clientY / window.innerHeight) * 2 - 1;
		};

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			x += (targetX - x) * 0.055;
			y += (targetY - y) * 0.055;
			const t = (now - born) / 1000;
			if (sway) sway.style.transform = `rotate(${Math.sin(t * 0.32) * 2.2 + x * 1.4}deg)`;
			if (band) band.style.transform = `translate3d(${x * 9}px, ${y * 9}px, 0)`;
			petals.forEach((petal, i) => {
				const depth = 22 + i * 6;
				const breath = 1 + Math.sin(t * 0.9 + i * 1.4) * 0.022;
				petal.style.transform = `translate3d(${x * depth}px, ${y * depth}px, 0) scale(${breath})`;
			});
		};

		const start = () => {
			if (raf) return;
			window.addEventListener('pointermove', onMove, { passive: true });
			raf = requestAnimationFrame(tick);
		};
		const stop = () => {
			cancelAnimationFrame(raf);
			raf = 0;
			window.removeEventListener('pointermove', onMove);
		};
		return whileVisible(el, start, stop);
	});
</script>

<div bind:this={root} class="aspect-square {className}" aria-hidden="true">
	<div data-sway class="relative size-full">
		<div data-depth-band class="absolute inset-0">
			<div data-bloom-band data-intro-hide class="size-full">
				<svg viewBox={MARK_VIEWBOX} class="size-full">
					<path d={MARK_RING} fill="#fff" fill-rule="evenodd" />
				</svg>
			</div>
		</div>
		{#each PETALS as petal, i (i)}
			{@const b = petalBox(petal)}
			<div
				data-depth-petal
				class="absolute"
				style:left="{b.left}%"
				style:top="{b.top}%"
				style:width="{b.size}%"
				style:height="{b.size}%"
			>
				<div data-bloom-petal data-intro-hide class="size-full rounded-full bg-white"></div>
			</div>
		{/each}
	</div>
</div>
