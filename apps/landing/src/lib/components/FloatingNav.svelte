<script lang="ts">
	import { onMount } from 'svelte';
	import { animate } from 'motion';
	import { fly } from 'svelte/transition';
	import { Menu, X } from 'lucide-svelte';
	import { links } from '$lib/links';
	import HackClubFlag from './HackClubFlag.svelte';
	import { prefersReduced, transition } from '$lib/motion.svelte';

	const SECTIONS = [
		{ id: 'how', label: 'What it is' },
		{ id: 'kubernetes', label: 'Kubernetes' },
		{ id: 'features', label: 'Features' },
		{ id: 'agents', label: 'Agents' },
		{ id: 'cli', label: 'CLI' },
		{ id: 'self-host', label: 'Self-host' }
	];

	let shown = $state(false);
	let active = $state('');
	let open = $state(false);
	let rail = $state<HTMLElement | null>(null);
	let indicator = $state<HTMLElement | null>(null);

	onMount(() => {
		let frame = 0;
		const check = () => {
			frame = 0;
			const hero = document.getElementById('hero');
			const edge = hero ? hero.offsetTop + hero.offsetHeight - 72 : 600;
			const next = window.scrollY > edge;
			if (next !== shown) shown = next;
			if (!next) open = false;
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(check);
		};
		check();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll, { passive: true });

		const spy = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) active = entry.target.id;
					else if (active === entry.target.id) active = '';
				}
			},
			{ rootMargin: '-45% 0px -50% 0px' }
		);
		for (const s of SECTIONS) {
			const el = document.getElementById(s.id);
			if (el) spy.observe(el);
		}

		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			spy.disconnect();
		};
	});

	$effect(() => {
		const id = active;
		const bar = indicator;
		const host = rail;
		if (!bar || !host) return;
		const link = id ? host.querySelector<HTMLElement>(`[data-section="${id}"]`) : null;
		if (!link) {
			animate(bar, { opacity: 0 }, { duration: 0.2 });
			return;
		}
		const target = { x: link.offsetLeft, width: link.offsetWidth, opacity: 1 };
		if (prefersReduced() || bar.style.opacity !== '1') {
			animate(bar, target, { duration: 0 });
			return;
		}
		animate(bar, target, transition('snappy'));
	});
</script>

<nav
	aria-label="Sections"
	class="fixed inset-x-0 top-3 z-50 flex justify-center px-3 transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] {shown
		? 'translate-y-0 opacity-100'
		: 'pointer-events-none -translate-y-[140%] opacity-0'}"
	inert={!shown}
>
	<div
		class="relative flex w-full max-w-[1040px] items-center gap-2 rounded-2xl bg-crimson/92 p-2 text-white shadow-[0_18px_40px_-18px_rgb(120_0_20/0.6)] ring-1 ring-white/15 backdrop-blur-md"
	>
		<a
			href="#hero"
			aria-label="Back to top"
			class="shrink-0 rounded-lg p-1 focus-visible:outline-3 focus-visible:outline-cream"
		>
			<img src="/brand/logo-tile.svg" alt="" width="32" height="32" class="size-8 rounded-md" />
		</a>
		<span class="h-7 w-px shrink-0 bg-white/30" aria-hidden="true"></span>
		<a
			href="#hackclub"
			aria-label="What is Hack Club?"
			class="shrink-0 rounded-md p-1 text-white transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-rotate-6 hover:scale-105 focus-visible:outline-3 focus-visible:outline-cream"
		>
			<HackClubFlag class="h-[30px] w-auto" />
		</a>

		<div
			bind:this={rail}
			class="relative flex flex-1 items-center justify-center gap-1 max-lg:hidden"
		>
			<span
				bind:this={indicator}
				class="absolute top-0 left-0 h-full rounded-lg bg-white/18"
				style:opacity="0"
				aria-hidden="true"
			></span>
			{#each SECTIONS as s (s.id)}
				<a
					href="#{s.id}"
					data-section={s.id}
					aria-current={active === s.id ? 'location' : undefined}
					class="relative rounded-lg px-2.5 py-2 text-[15px] font-medium xl:px-3 whitespace-nowrap transition-colors focus-visible:outline-3 focus-visible:outline-cream {active ===
					s.id
						? 'text-white'
						: 'text-cream hover:text-white'}"
				>
					{s.label}
				</a>
			{/each}
			<a
				href={links.templates}
				class="relative rounded-lg px-2.5 py-2 text-[15px] font-medium xl:px-3 text-cream transition-colors hover:text-white focus-visible:outline-3 focus-visible:outline-cream"
			>
				Templates
			</a>
			<a
				href={links.docs}
				class="relative rounded-lg px-2.5 py-2 text-[15px] font-medium xl:px-3 text-cream transition-colors hover:text-white focus-visible:outline-3 focus-visible:outline-cream"
			>
				Docs
			</a>
		</div>

		<div class="ml-auto flex items-center gap-2">
			<a href={links.install} class="pill pill-sm py-2 font-medium">Install Orchard</a>
			<button
				type="button"
				onclick={() => (open = !open)}
				aria-expanded={open}
				aria-controls="section-menu"
				class="grid size-11 place-items-center rounded-lg text-white hover:bg-white/15 focus-visible:outline-3 focus-visible:outline-cream lg:hidden"
			>
				<span class="sr-only">{open ? 'Close sections' : 'Open sections'}</span>
				{#if open}
					<X size={20} strokeWidth={2} aria-hidden="true" />
				{:else}
					<Menu size={20} strokeWidth={2} aria-hidden="true" />
				{/if}
			</button>
		</div>

		{#if open}
			<ul
				id="section-menu"
				class="absolute inset-x-0 top-[calc(100%+8px)] flex flex-col rounded-2xl bg-crimson p-2 shadow-[0_18px_40px_-18px_rgb(120_0_20/0.6)] ring-1 ring-white/15 lg:hidden"
				transition:fly={{ y: -8, duration: prefersReduced() ? 0 : 200 }}
			>
				{#each SECTIONS as s (s.id)}
					<li>
						<a
							href="#{s.id}"
							onclick={() => (open = false)}
							class="block rounded-lg px-4 py-3 font-medium hover:bg-white/15 focus-visible:outline-3 focus-visible:outline-cream {active ===
							s.id
								? 'bg-white/15'
								: ''}"
						>
							{s.label}
						</a>
					</li>
				{/each}
				<li>
					<a
						href={links.templates}
						class="block rounded-lg px-4 py-3 font-medium hover:bg-white/15 focus-visible:outline-3 focus-visible:outline-cream"
						>Templates</a
					>
				</li>
				<li>
					<a
						href={links.docs}
						class="block rounded-lg px-4 py-3 font-medium hover:bg-white/15 focus-visible:outline-3 focus-visible:outline-cream"
						>Docs</a
					>
				</li>
			</ul>
		{/if}
	</div>
</nav>
