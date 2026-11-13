<script lang="ts">
	import Hero from '$lib/components/Hero.svelte';
	import FloatingNav from '$lib/components/FloatingNav.svelte';
	import Kubernetes from '$lib/components/Kubernetes.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import Agents from '$lib/components/Agents.svelte';
	import Platform from '$lib/components/Platform.svelte';
	import Cli from '$lib/components/Cli.svelte';
	import SelfHost from '$lib/components/SelfHost.svelte';
	import HackClub from '$lib/components/HackClub.svelte';
	import Closing from '$lib/components/Closing.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import Seo from '$lib/components/Seo.svelte';

	import { links } from '$lib/links';
	import { SITE } from '$lib/site';

	const title = 'Orchard · Open-source, self-hosted PaaS';
	const description =
		'Orchard is an open-source, self-hosted platform as a service from Hack Club. One command installs it on a Linux server, then you deploy apps from Git with Postgres, HTTPS, logs and an MCP server.';

	const jsonLd = {
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'Organization',
				'@id': 'https://hackclub.com/#org',
				name: 'Hack Club',
				url: 'https://hackclub.com',
				sameAs: ['https://en.wikipedia.org/wiki/Hack_Club', 'https://github.com/hackclub']
			},
			{
				'@type': 'WebSite',
				'@id': `${SITE}/#site`,
				url: SITE,
				name: 'Orchard',
				alternateName: 'Orchard',
				publisher: { '@id': 'https://hackclub.com/#org' }
			},
			{
				'@type': 'SoftwareApplication',
				'@id': `${SITE}/#app`,
				name: 'Orchard',
				alternateName: 'Orchard',
				description,
				applicationCategory: 'DeveloperApplication',
				operatingSystem: 'Linux',
				url: SITE,
				downloadUrl: links.install,
				softwareHelp: links.docs,
				license: 'https://www.gnu.org/licenses/agpl-3.0.html',
				isAccessibleForFree: true,
				offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
				publisher: { '@id': 'https://hackclub.com/#org' },
				sameAs: [links.github]
			}
		]
	};
</script>

<Seo {title} {description} {jsonLd} />

<Hero />
<FloatingNav />

<main>
	<HowItWorks />
	<Kubernetes />
	<Platform />
	<Agents />
	<Cli />
	<SelfHost />
	<HackClub />
</main>

<div class="bg-crimson pt-12">
	<hr class="h-1 border-0 bg-blush" />
	<Closing />
	<hr class="h-1 border-0 bg-blush" />
	<Footer />
</div>
