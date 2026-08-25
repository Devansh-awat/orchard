<script lang="ts">
	import Nav from '$lib/components/Nav.svelte';
	import Hero from '$lib/components/Hero.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import Features from '$lib/components/Features.svelte';
	import Mcp from '$lib/components/Mcp.svelte';
	import Cli from '$lib/components/Cli.svelte';
	import SelfHost from '$lib/components/SelfHost.svelte';
	import Closing from '$lib/components/Closing.svelte';
	import Footer from '$lib/components/Footer.svelte';

	const title = 'Orchard · Kubernetes, made easy';
	const description =
		'Orchard runs on your own Kubernetes cluster and turns a GitHub repo into a running app: builds, HTTPS, databases, jobs, logs, rollbacks, and MCP for AI agents.';
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:image" content="/screenshots/project.png" />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content="/screenshots/project.png" />
</svelte:head>

<Nav />
<main class="isolate pt-16">
	<Hero />
	<HowItWorks />
	<Features />
	<Mcp />
	<Cli />
	<SelfHost />
	<Closing />
</main>
<Footer />
