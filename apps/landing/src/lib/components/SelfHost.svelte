<script lang="ts">
	import { ArrowUpRight } from 'lucide-svelte';
	import Terminal from './Terminal.svelte';
	import { installScript, links } from '$lib/links';
	import { hover, reveal } from '$lib/motion.svelte';

	const POINTS: {
		title: string;
		body: string;
		link?: { label: string; href: string; after: string };
	}[] = [
		{
			title: 'What you need',
			body: 'A Linux server, amd64 or arm64, with at least 4\u00a0GB of RAM (8\u00a0GB is comfortable) and 20\u00a0GB of free disk. Already run a cluster? The guide covers the Helm chart.'
		},
		{
			title: 'Your data stays yours',
			body: 'Your apps and databases live on machines you own. Orchard collects nothing from users unless',
			link: { label: 'statistics are enabled', href: links.telemetry, after: '.' }
		},
		{
			title: 'Costs nothing',
			body: 'Orchard is free. You only pay for the machines you run it on.'
		},
		{
			title: 'Open source',
			body: 'Every line of Orchard is public under the',
			link: {
				label: 'AGPL',
				href: links.license,
				after: ' (the graft SDK is MIT).'
			}
		}
	];

	const INSTALLER = [
		{ kind: 'cmd', text: installScript },
		{ kind: 'out', text: ' ' },
		{ kind: 'out', text: 'ORCHARD   self-hosted app platform' },
		{ kind: 'dim', text: 'One box, one command. A few minutes on a clean machine.' },
		{ kind: 'out', text: ' ' },
		{ kind: 'out', text: 'What happens next' },
		{ kind: 'dim', text: ' 1  Check this machine' },
		{ kind: 'dim', text: ' 2  Find how traffic gets in' },
		{ kind: 'dim', text: ' 3  Choose domains' },
		{ kind: 'dim', text: ' 4  Install k3s' },
		{ kind: 'dim', text: ' 5  Install Helm' },
		{ kind: 'dim', text: ' 6  Install platform operators' },
		{ kind: 'dim', text: ' 7  Install the container registry' },
		{ kind: 'dim', text: ' 8  Install the Cloudflare tunnel' },
		{ kind: 'dim', text: ' 9  Write the configuration' },
		{ kind: 'dim', text: '10  Install Orchard' },
		{ kind: 'dim', text: '11  Install the updater' },
		{ kind: 'dim', text: '12  Finish' }
	] as const;
</script>

<section id="self-host" class="scroll-mt-24 pt-[clamp(3rem,6vw,96px)] pb-[clamp(4rem,8vw,128px)]">
	<div class="shell grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-12">
		<div class="lg:col-span-5">
			<h2
				{@attach reveal({ index: 1 })}
				class="text-[clamp(2rem,3.6vw,3rem)] leading-[1.1] font-bold tracking-[-0.02em] text-balance text-crimson-deep"
			>
				Your cluster, your orchard.
			</h2>
			<p
				{@attach reveal({ index: 2 })}
				class="mt-5 max-w-[48ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-[1.55] font-medium text-pretty text-crimson-deep"
			>
				One command sets up k3s and Orchard on a Linux server, asking a few questions along the way.
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

			<div {@attach reveal({ index: 7 })} class="mt-6 flex flex-wrap items-center gap-3">
				<a {@attach hover()} href={links.install} class="pill-solid px-5 py-3 font-semibold">
					Read the install guide <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
				</a>
				<a href={links.github} class="textlink">
					Contribute on GitHub <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
				</a>
			</div>
		</div>

		<div {@attach reveal({ index: 2, y: 24 })} class="min-w-0 lg:col-span-7">
			<Terminal lines={INSTALLER} copy={installScript} caret={false} />
		</div>
	</div>
</section>

<style>
	.textlink {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border-radius: 8px;
		padding: 0.625rem 0.5rem;
		font-weight: 600;
		color: var(--color-crimson-deep);
		text-decoration: underline;
		text-decoration-color: rgb(195 16 38 / 0.4);
		text-underline-offset: 4px;
		transition: text-decoration-color 0.18s ease;
	}

	.textlink:hover {
		text-decoration-color: var(--color-crimson-deep);
	}

	.textlink:focus-visible {
		outline: 3px solid var(--color-crimson-deep);
		outline-offset: 3px;
	}
</style>
