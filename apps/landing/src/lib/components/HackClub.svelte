<script lang="ts">
	import hackathon from '$lib/assets/hackclub/hackathon.webp';
	import soldering from '$lib/assets/hackclub/soldering.webp';
	import crowd from '$lib/assets/hackclub/crowd.webp';
	import orpheusBoba from '$lib/assets/hackclub/orpheus-boba.webp';
	import orpheusLeft from '$lib/assets/brand/hackclub-orpheus-left.svg';
	import { animate, inView, stagger } from 'motion';
	import { ArrowUpRight } from 'lucide-svelte';
	import { links } from '$lib/links';
	import { hover, prefersReduced, reveal } from '$lib/motion.svelte';

	const PHOTOS = [
		{
			src: hackathon,
			alt: 'Teenagers coding on sticker-covered laptops at a Hack Club hackathon',
			style: 'left: 0%; top: 9%; width: 57%; --tilt: -4deg; --tape: -6deg'
		},
		{
			src: soldering,
			alt: 'Two teenagers building electronics at a Hack Club event',
			style: 'left: 47%; top: 0%; width: 50%; --tilt: 3.5deg; --tape: 4deg'
		},
		{
			src: crowd,
			alt: 'A crowd of Hack Clubbers smiling behind a table of cupcakes',
			style: 'left: 24%; top: 47%; width: 54%; --tilt: -1.5deg; --tape: -2deg'
		}
	];

	function reach() {
		return (el: Element) => {
			const arm = el as HTMLElement;
			arm.classList.add('motion-hidden');
			return inView(
				arm,
				() => {
					const done = () => arm.classList.remove('motion-hidden');
					if (prefersReduced()) {
						animate(arm, { opacity: [0, 1] }, { duration: 0.26 }).finished.then(done);
						return;
					}
					animate(
						arm,
						{ opacity: [0, 1], x: ['-70%', '0%'], rotate: [-10, 0] },
						{
							opacity: { duration: 0.3 },
							x: { duration: 0.75, ease: [0.22, 1, 0.36, 1] },
							rotate: { type: 'spring', visualDuration: 0.7, bounce: 0.55, delay: 0.15 }
						}
					).finished.then(done);
				},
				{ margin: '0px 0px -12% 0px', amount: 'some' }
			);
		};
	}

	function scatter() {
		return (el: Element) => {
			const pile = el as HTMLElement;
			const prints = [...pile.querySelectorAll<HTMLElement>('[data-print]')];
			const sticker = pile.querySelector<HTMLElement>('[data-sticker]');
			const all = sticker ? [...prints, sticker] : prints;
			for (const item of all) item.classList.add('motion-hidden');
			return inView(
				pile,
				() => {
					const done = () => all.forEach((item) => item.classList.remove('motion-hidden'));
					if (prefersReduced()) {
						animate(all, { opacity: [0, 1] }, { duration: 0.26 }).finished.then(done);
						return;
					}
					const settle = animate(
						prints,
						{ opacity: [0, 1], y: [-28, 0], scale: [1.1, 1], rotate: [7, 0] },
						{
							type: 'spring',
							visualDuration: 0.5,
							bounce: 0.3,
							delay: stagger(0.14, { startDelay: 0.2 })
						}
					);
					if (!sticker) {
						settle.finished.then(done);
						return;
					}
					animate(
						sticker,
						{ opacity: [0, 1], scale: [1.7, 1], rotate: [28, 0] },
						{
							type: 'spring',
							visualDuration: 0.45,
							bounce: 0.5,
							delay: 0.4 + prints.length * 0.14
						}
					).finished.then(done);
				},
				{ margin: '0px 0px -15% 0px', amount: 'some' }
			);
		};
	}
</script>

<section id="hackclub" class="relative scroll-mt-24 overflow-x-clip pb-[clamp(5rem,9vw,136px)]">
	<img
		{@attach reach()}
		src={orpheusLeft}
		alt=""
		width="280"
		height="158"
		class="arm pointer-events-none absolute top-0 left-0 z-10 h-auto origin-left"
	/>

	<div class="shell grid grid-cols-1 items-center gap-y-16 lg:grid-cols-12 lg:gap-x-12">
		<div class="copy lg:col-span-5">
			<h2
				{@attach reveal({ index: 1 })}
				class="text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-balance text-crimson"
			>
				What is Hack Club?
			</h2>
			<p
				{@attach reveal({ index: 2 })}
				class="mt-5 max-w-[48ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-[1.55] font-medium text-pretty text-crimson-deep"
			>
				A nonprofit where teenagers make cool stuff together. Clubs, hackathons, and a Slack full of
				people shipping projects like this one. If you’re 13 to 18, you’re invited.
			</p>
			<a
				{@attach reveal({ index: 3 })}
				{@attach hover()}
				href={links.joinHackClub}
				class="pill-solid mt-8 px-5 py-3 font-semibold"
			>
				Join Hack Club <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
			</a>
		</div>

		<div {@attach scatter()} class="relative aspect-[1.4] w-full lg:col-span-7">
			{#each PHOTOS as photo (photo.src)}
				<figure data-print class="print absolute" style={photo.style}>
					<img
						src={photo.src}
						alt={photo.alt}
						width="512"
						height="318"
						loading="lazy"
						class="block h-auto w-full rounded-[3px]"
					/>
				</figure>
			{/each}
			<img
				data-sticker
				src={orpheusBoba}
				alt=""
				width="240"
				height="300"
				loading="lazy"
				class="sticker absolute right-[3%] bottom-[2%] w-[17%]"
			/>
		</div>
	</div>
</section>

<style>
	section {
		--arm: clamp(240px, 27vw, 400px);
	}

	.arm {
		width: var(--arm);
	}

	.copy {
		padding-top: calc(var(--arm) * 0.52);
	}

	.print {
		margin: 0;
		rotate: var(--tilt);
		border-radius: 6px;
		background: #fff;
		padding: 0.5rem;
		box-shadow:
			0 1px 2px rgb(120 0 20 / 0.1),
			0 18px 32px -14px rgb(120 0 20 / 0.38);
		transition:
			rotate 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
			scale 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.print::before {
		content: '';
		position: absolute;
		top: -0.7rem;
		left: 50%;
		width: 5.5rem;
		height: 1.4rem;
		translate: -50% 0;
		rotate: var(--tape);
		background: rgb(255 173 189 / 0.62);
		box-shadow: 0 1px 2px rgb(120 0 20 / 0.08);
	}

	.print:hover {
		z-index: 5;
		rotate: 0deg;
		scale: 1.03;
	}

	.sticker {
		z-index: 6;
		rotate: 10deg;
		filter: drop-shadow(0 10px 14px rgb(120 0 20 / 0.25));
		transition: rotate 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.sticker:hover {
		rotate: -4deg;
	}
</style>
