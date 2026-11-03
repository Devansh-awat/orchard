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

	const title = 'Hack Club Orchard · Your own cloud in one command';
	const description =
		'Orchard turns a GitHub repo into a running app on your own Kubernetes cluster, with databases, HTTPS, logs, and an MCP server for your agents.';
</script>

<Seo {title} {description} />

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
