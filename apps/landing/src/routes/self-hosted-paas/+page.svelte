<script lang="ts">
	import {
		ArrowUpRight,
		Bot,
		Database,
		GitBranch,
		Github,
		KeyRound,
		Layers,
		LayoutGrid,
		Plus,
		Server,
		ShieldCheck,
		Sprout,
		Timer,
		Users,
		Wallet
	} from 'lucide-svelte';
	import Logo from '$lib/components/Logo.svelte';
	import HeroMark from '$lib/components/HeroMark.svelte';
	import WaveEdge from '$lib/components/WaveEdge.svelte';
	import PromptCopy from '$lib/components/PromptCopy.svelte';
	import Closing from '$lib/components/Closing.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { links } from '$lib/links';

	const DOCS = links.docs;

	const REASONS = [
		{
			icon: Server,
			title: 'Your servers, your data',
			text: 'Apps, databases and logs stay on machines you control, in the country you choose.'
		},
		{
			icon: Wallet,
			title: 'One bill, for the server',
			text: 'Run as many apps, databases and people as the server holds. Nothing is priced per app or per seat.'
		},
		{
			icon: KeyRound,
			title: 'No lock-in',
			text: 'Orchard is open source under AGPL-3.0. Your apps are ordinary containers on standard Kubernetes.'
		},
		{
			icon: Sprout,
			title: 'Room to grow',
			text: 'Start on one cheap server. Add nodes, standby databases and SSO when you need them.'
		}
	];

	const STEPS = [
		{
			title: 'Install',
			text: 'Run one command on a Linux server, amd64 or arm64. It sets up Kubernetes for you.'
		},
		{
			title: 'Connect a repo',
			text: 'Orchard finds each app inside and works out the framework, the commands and the port.'
		},
		{
			title: 'Push',
			text: 'Your app gets an HTTPS URL, and every push to your branch ships a new version.'
		}
	];

	const FEATURES = [
		{
			icon: GitBranch,
			title: 'Deploy from Git',
			text: 'Choose a repo and a branch. Orchard figures out the rest.',
			href: `${DOCS}/deploy/github/`
		},
		{
			icon: ShieldCheck,
			title: 'HTTPS for every app',
			text: 'A URL with a certificate for each app, plus your own domains.',
			href: `${DOCS}/deploy/domains/`
		},
		{
			icon: Database,
			title: 'Postgres to any second',
			text: 'Continuous backups, forks, failover and rehearsed major upgrades.',
			href: `${DOCS}/data/backups/`
		},
		{
			icon: Layers,
			title: 'Scale with one control',
			text: 'Add copies of an app and traffic spreads across them.',
			href: `${DOCS}/deploy/scaling/`
		},
		{
			icon: Timer,
			title: 'Jobs, logs and alerts',
			text: 'Cron jobs, live logs, metrics, alerts and public status pages.',
			href: `${DOCS}/run/jobs/`
		},
		{
			icon: Users,
			title: 'Teams',
			text: 'Organizations, roles, SSO, SCIM, audit logs and quotas.',
			href: `${DOCS}/teams/organizations/`
		},
		{
			icon: LayoutGrid,
			title: 'Templates',
			text: 'More than 90 ready-made apps, from n8n to a Minecraft server.',
			href: links.templates
		},
		{
			icon: Bot,
			title: 'AI agents',
			text: 'Let an agent deploy, add databases and read logs through MCP.',
			href: `${DOCS}/mcp/`
		}
	];

	const FAQ = [
		{
			q: 'What is a self-hosted PaaS?',
			a: 'A platform as a service (PaaS) builds your code, runs it and routes traffic to it, so you push code instead of managing servers. A self-hosted PaaS does this on servers you own.'
		},
		{
			q: 'Do I need to know Kubernetes?',
			a: 'No. Orchard runs on Kubernetes, but the installer sets up a k3s cluster and every component for you. You use the dashboard, the CLI or an AI agent.'
		},
		{
			q: 'What server do I need?',
			a: 'Any Linux machine or VM with an amd64 or arm64 CPU. A small instance with a database idles at about 2.5 GiB of memory, and the installer trims itself to fit smaller servers. More memory leaves room for builds and more apps. If you already run Kubernetes, install the Helm chart instead.'
		},
		{
			q: 'What happens to my apps if Orchard stops?',
			a: 'They keep running and serving traffic. Apps and databases are ordinary Kubernetes workloads, so only builds, deploys and other changes wait until Orchard is back.'
		},
		{
			q: 'Can other people deploy on my instance?',
			a: 'Yes, with care. Apps cannot reach each other over the network by default, but they share the host kernel. Turn on the gVisor and Kata sandboxes before people you do not trust deploy code.',
			href: links.security,
			label: 'Security and isolation'
		},
		{
			q: 'Is Orchard free?',
			a: 'Yes. Orchard is open source under AGPL-3.0, and single sign-on, SCIM, quotas and audit logs are included. Hack Club runs its own apps on it.'
		},
		{
			q: 'How does Orchard compare with other self-hosted platforms?',
			a: 'The comparison lists features side by side, with a source for every answer.',
			href: links.compare,
			label: 'Compare'
		}
	];

	const jsonLd = {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: FAQ.map((item) => ({
			'@type': 'Question',
			name: item.q,
			acceptedAnswer: { '@type': 'Answer', text: item.a }
		}))
	};

	const title = 'Self-hosted PaaS for your own server · Orchard';
	const description =
		'Orchard is an open-source, self-hosted PaaS from Hack Club. Install it on your own Linux server with one command, then deploy from Git with HTTPS, Postgres, jobs, SSO and an MCP server.';
</script>

<Seo {title} {description} {jsonLd} />

<header class="relative isolate overflow-hidden bg-crimson pb-[90px] text-white">
	<div
		class="pointer-events-none absolute -right-[140px] -bottom-[150px] -z-10 hidden w-[620px] xl:block"
		aria-hidden="true"
	>
		<HeroMark class="w-full" />
	</div>

	<div class="shell pt-8">
		<nav class="flex items-center justify-between gap-4" aria-label="Main">
			<a
				href="/"
				aria-label="Orchard home"
				class="rounded-sm focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cream"
			>
				<Logo />
			</a>
			<div class="flex items-center gap-2">
				<a
					href={links.github}
					aria-label="Orchard on GitHub"
					title="Orchard on GitHub"
					class="gh inline-flex size-11 items-center justify-center rounded-lg text-white"
				>
					<Github size={20} strokeWidth={2} aria-hidden="true" />
				</a>
				<a href={links.install} class="pill pill-sm">Install Orchard</a>
			</div>
		</nav>

		<div class="pt-[clamp(3.5rem,10vh,7rem)] pb-[clamp(3rem,8vh,5rem)]">
			<h1 class="text-[clamp(2.5rem,5.2vw,4rem)] leading-[1.2] font-medium">
				<span class="block">A <span class="font-extrabold">self-hosted</span> PaaS</span>
				<span class="block">on <em class="pr-[0.04em] font-extrabold">your</em> server</span>
			</h1>
			<p
				class="mt-3 max-w-[640px] text-[clamp(1.25rem,1.9vw,1.6rem)] leading-snug text-pretty text-cream"
			>
				Orchard is an open-source platform as a service from Hack Club. Push code, and it builds,
				runs and serves your app.
			</p>
			<div class="mt-8">
				<PromptCopy />
			</div>
		</div>
	</div>

	<div class="absolute inset-x-0 bottom-0 h-[90px]">
		<WaveEdge fill="#ffdfe3" />
		<div class="h-[55px] bg-blush"></div>
	</div>
</header>

<main>
	<section
		class="shell pt-[clamp(2rem,4vw,48px)] pb-[clamp(4rem,8vw,110px)]"
		aria-labelledby="yours"
	>
		<h2 id="yours" class="section-title text-crimson-deep">Yours, all the way down</h2>
		<p class="section-lead mx-auto mt-3 max-w-[640px] text-crimson-deep/80">
			Everything a hosted platform does, on hardware you already pay for.
		</p>
		<ul class="mt-8 grid gap-3 sm:mt-12 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
			{#each REASONS as reason (reason.title)}
				<li class="tile reason">
					<span class="icon" aria-hidden="true">
						<reason.icon size={20} strokeWidth={2} />
					</span>
					<div class="body">
						<h3 class="text-[1.0625rem] font-bold text-crimson-deep">{reason.title}</h3>
						<p class="mt-1 leading-normal text-pretty text-crimson-deep/80">{reason.text}</p>
					</div>
				</li>
			{/each}
		</ul>
	</section>

	<section class="relative bg-crimson text-white" aria-labelledby="steps">
		<WaveEdge fill="#f9445a" class="absolute inset-x-0 bottom-full" />
		<div class="shell py-[clamp(3.5rem,7vw,96px)]">
			<h2 id="steps" class="section-title">One command, then git push</h2>
			<ol class="mt-8 grid gap-6 sm:mt-12 md:grid-cols-3 md:gap-8">
				{#each STEPS as step, i (step.title)}
					<li class="step">
						<span class="num" aria-hidden="true">{i + 1}</span>
						<div class="body">
							<h3 class="text-[1.25rem] font-bold">{step.title}</h3>
							<p
								class="mt-1.5 max-w-[340px] text-[1.0625rem] leading-normal text-pretty text-cream"
							>
								{step.text}
							</p>
						</div>
					</li>
				{/each}
			</ol>
		</div>
		<WaveEdge fill="#ffdfe3" class="relative" />
	</section>

	<section class="shell pt-[clamp(2rem,4vw,48px)]" aria-labelledby="features">
		<h2 id="features" class="section-title text-crimson-deep">Everything in the box</h2>
		<p class="section-lead mx-auto mt-3 max-w-[640px] text-crimson-deep/80">
			The parts you would otherwise wire together yourself.
		</p>
		<ul class="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
			{#each FEATURES as feature (feature.title)}
				<li>
					<a class="tile card group" href={feature.href}>
						<span class="icon" aria-hidden="true">
							<feature.icon size={20} strokeWidth={2} />
						</span>
						<span class="body">
							<span class="block text-[1.0625rem] font-bold text-crimson-deep">{feature.title}</span
							>
							<span class="mt-1 block leading-normal text-pretty text-crimson-deep/80"
								>{feature.text}</span
							>
						</span>
						<span class="arrow" aria-hidden="true">
							<ArrowUpRight
								size={18}
								strokeWidth={2}
								class="text-crimson-deep/40 transition-colors group-hover:text-crimson-deep"
							/>
						</span>
					</a>
				</li>
			{/each}
		</ul>
		<p class="mt-6 text-center">
			<a class="link" href="{DOCS}/start/features/">See every feature</a>
		</p>
	</section>

	<section
		class="shell pt-[clamp(4rem,8vw,110px)] pb-[clamp(4rem,8vw,120px)]"
		aria-labelledby="faq"
	>
		<h2 id="faq" class="section-title text-crimson-deep">Frequently asked questions</h2>
		<div class="faq-box mx-auto mt-10 max-w-[860px]">
			{#each FAQ as item (item.q)}
				<details class="faq">
					<summary>
						<span>{item.q}</span>
						<Plus size={20} strokeWidth={2.25} class="plus shrink-0" aria-hidden="true" />
					</summary>
					<p>
						{item.a}
						{#if item.href}
							<a class="link" href={item.href}>{item.label}</a>
						{/if}
					</p>
				</details>
			{/each}
		</div>
	</section>
</main>

<div class="bg-crimson pt-[46px]">
	<hr class="h-1 border-0 bg-blush" />
	<Closing />
	<hr class="h-1 border-0 bg-blush" />
	<Footer />
</div>

<style>
	.gh {
		background: rgb(195 16 38 / 0.35);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16);
		transition: background-color 0.18s ease;
	}

	.gh:hover {
		background: var(--color-crimson-deep);
	}

	.gh:focus-visible {
		outline: 3px solid var(--color-cream);
		outline-offset: 3px;
	}

	.tile {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: 'icon body arrow';
		column-gap: 0.9rem;
		align-items: start;
		height: 100%;
		padding: 1rem;
		border-radius: 16px;
		background: #fff;
		box-shadow:
			0 1px 0 rgb(195 16 38 / 0.08),
			0 20px 50px -30px rgb(195 16 38 / 0.35);
	}

	.tile .icon {
		grid-area: icon;
	}

	.tile .body {
		grid-area: body;
		display: block;
	}

	.tile .arrow {
		grid-area: arrow;
	}

	@media (min-width: 640px) {
		.tile {
			grid-template-columns: auto minmax(0, 1fr) auto;
			grid-template-areas:
				'icon . arrow'
				'body body body';
			row-gap: 1rem;
			padding: 1.25rem;
		}
	}

	.step {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 1rem;
		align-items: start;
	}

	@media (min-width: 768px) {
		.step {
			grid-template-columns: 1fr;
			row-gap: 0.75rem;
		}
	}

	.num {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: 999px;
		background: var(--color-cream);
		color: var(--color-crimson);
		font-size: 1.25rem;
		font-weight: 800;
	}

	.card {
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease;
	}

	.card:hover {
		transform: translateY(-2px);
		box-shadow:
			0 1px 0 rgb(195 16 38 / 0.08),
			0 26px 50px -28px rgb(195 16 38 / 0.45);
	}

	.card:focus-visible {
		outline: 3px solid var(--color-crimson-deep);
		outline-offset: 3px;
	}

	.icon {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 10px;
		background: var(--color-blush);
		color: var(--color-crimson);
	}

	.faq-box {
		border-radius: 20px;
		background: #fff;
		box-shadow:
			0 1px 0 rgb(195 16 38 / 0.08),
			0 20px 50px -30px rgb(195 16 38 / 0.35);
		overflow: hidden;
		color: var(--color-crimson-deep);
	}

	.faq + .faq {
		border-top: 1px solid rgb(195 16 38 / 0.1);
	}

	.faq summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.1rem 1.4rem;
		font-size: 1.0625rem;
		font-weight: 700;
		cursor: pointer;
		list-style: none;
	}

	.faq summary::-webkit-details-marker {
		display: none;
	}

	.faq summary:focus-visible {
		outline: 3px solid var(--color-crimson-deep);
		outline-offset: -3px;
	}

	.faq :global(.plus) {
		transition: transform 0.2s ease;
	}

	.faq[open] :global(.plus) {
		transform: rotate(45deg);
	}

	.faq p {
		padding: 0 1.4rem 1.2rem;
		line-height: 1.6;
		color: rgb(195 16 38 / 0.85);
	}

	.link {
		font-weight: 600;
		color: var(--color-crimson-deep);
		text-decoration: underline;
		text-decoration-color: rgb(195 16 38 / 0.35);
		text-underline-offset: 3px;
	}

	.link:hover {
		text-decoration-color: currentColor;
	}

	@media (prefers-reduced-motion: reduce) {
		.card,
		.card:hover {
			transition: none;
			transform: none;
		}
	}
</style>
