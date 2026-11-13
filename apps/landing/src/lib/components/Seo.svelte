<script lang="ts">
	import { page } from '$app/state';
	import { absolute } from '$lib/site';

	let {
		title,
		description,
		image,
		jsonLd
	}: { title: string; description: string; image?: string; jsonLd?: object } = $props();

	const structured = $derived(
		jsonLd
			? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</` +
					'script>'
			: ''
	);

	const url = $derived(absolute(page.url.pathname));
	const picture = $derived(absolute(image ?? '/og.png'));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:site_name" content="Orchard" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:type" content="website" />
	<meta property="og:image" content={picture} />
	{#if !image}
		<meta property="og:image:width" content="1200" />
		<meta property="og:image:height" content="630" />
		<meta
			property="og:image:alt"
			content="Orchard: your own cloud in one command. An Orchard project with its apps and databases."
		/>
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={picture} />
	{#if structured}
		{@html structured}
	{/if}
</svelte:head>
