<script lang="ts">
	import { ArrowUpRight } from 'lucide-svelte';
	import AsciiVine from './AsciiVine.svelte';
	import { links } from '$lib/links';
	import { hover, reveal } from '$lib/motion.svelte';

	const POINTS: {
		title: string;
		body: string;
		link?: { label: string; href: string; after: string };
	}[] = [
		{
			title: 'Your data stays yours',
			body: 'Your apps and databases live on machines you own. We never see any of it.'
		},
		{
			title: 'Costs nothing',
			body: 'Orchard is free. You only pay for the machines you run it on.'
		},
		{
			title: 'Open source',
			body: 'Every line of Orchard is public under the',
			link: { label: 'AGPL', href: links.license, after: ', and it always will be.' }
		}
	];
</script>

<section id="self-host" class="scroll-mt-24 pt-[clamp(3rem,6vw,96px)] pb-[clamp(4rem,8vw,128px)]">
	<div class="shell grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-12">
		<div class="lg:col-span-5">
			<h2
				{@attach reveal({ index: 1 })}
				class="text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-balance text-crimson"
			>
				Your cluster, your orchard.
			</h2>
			<p
				{@attach reveal({ index: 2 })}
				class="mt-5 max-w-[48ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-[1.55] font-medium text-pretty text-crimson-deep"
			>
				Run it on hardware you control, like Hack Club does.
			</p>

			<ul class="mt-9 flex flex-col">
				{#each POINTS as point, i (point.title)}
					<li {@attach reveal({ index: i + 3 })} class="border-t-2 border-crimson/15 py-4">
						<h3 class="font-semibold text-crimson-deep">{point.title}</h3>
						<p class="mt-1 max-w-[52ch] text-pretty text-crimson-deep">
							{point.body}
							{#if point.link}<a
									href={point.link.href}
									class="rounded-sm font-semibold underline decoration-crimson-deep/40 underline-offset-2 transition-colors hover:decoration-crimson-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-deep"
									>{point.link.label}</a
								>{point.link.after}{/if}
						</p>
					</li>
				{/each}
			</ul>

			<a
				{@attach reveal({ index: 6 })}
				{@attach hover()}
				href={links.github}
				class="pill-solid mt-6 px-5 py-3 font-semibold"
			>
				Contribute on GitHub <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
			</a>
		</div>

		<div
			{@attach reveal({ index: 2, y: 24 })}
			class="relative min-h-[26rem] overflow-hidden rounded-2xl bg-crimson lg:col-span-7 lg:min-h-[36rem]"
		>
			<div
				class="grain pointer-events-none absolute -inset-1/2 opacity-25"
				aria-hidden="true"
			></div>
			<AsciiVine class="absolute inset-0 h-full w-full" seed={19} />
		</div>
	</div>
</section>
