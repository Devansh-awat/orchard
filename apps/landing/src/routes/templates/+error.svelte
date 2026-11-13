<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import { links } from '$lib/links';
</script>

<svelte:head>
	<title>{page.status} · Templates · Orchard</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-crimson text-white">
	<div class="shell pt-8">
		<nav class="flex items-center justify-between gap-4" aria-label="Main">
			<a href="/" aria-label="Orchard home"><Logo /></a>
			<a href={links.install} class="pill pill-sm">Install Orchard</a>
		</nav>
	</div>
	<main class="shell flex flex-1 flex-col items-center justify-center py-24 text-center">
		<p class="font-mono text-sm opacity-80">{page.status}</p>
		<h1 class="mt-4 text-[clamp(2.5rem,7vw,5rem)] leading-none font-extrabold tracking-tight">
			{page.status === 404 ? 'No template by that name' : 'Something went wrong'}
		</h1>
		{#if page.status !== 404 && page.error?.message}
			<p class="mt-6 max-w-[520px] text-lg opacity-90">{page.error.message}</p>
		{/if}
		<a href={links.templates} class="pill pill-sm mt-10">Back to the gallery</a>
	</main>
</div>
