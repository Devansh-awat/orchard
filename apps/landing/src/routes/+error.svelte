<script lang="ts">
	import { page } from '$app/state';
	import { ArrowUpRight } from 'lucide-svelte';
	import Logo from '$lib/components/Logo.svelte';
	import CreditPill from '$lib/components/CreditPill.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import { links } from '$lib/links';

	const missing = $derived(page.status === 404);
	const extension = $derived(page.url.pathname.startsWith('/extensions/'));
	const heading = $derived.by(() => {
		if (!missing) return 'Something went wrong';
		return extension ? 'No extension by that name' : 'Page not found';
	});
</script>

<svelte:head>
	<title>{page.status} · Hack Club Orchard</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="bg-crimson text-white">
	<div class="flex min-h-svh flex-col">
		<div class="shell w-full pt-8">
			<nav class="relative flex items-center justify-between gap-4" aria-label="Main">
				<a
					href="/"
					aria-label="Hack Club Orchard home"
					class="rounded-sm focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cream"
				>
					<Logo />
				</a>
				<CreditPill
					class="absolute left-1/2 inline-flex -translate-x-1/2 items-center max-lg:hidden"
				/>
				<a href={links.install} class="pill pill-sm">Install Orchard</a>
			</nav>
			<CreditPill class="mt-5 inline-flex items-center self-start lg:hidden" />
		</div>

		<main class="shell flex w-full flex-1 flex-col items-center justify-center py-24 text-center">
			<p class="font-mono text-sm">{page.status}</p>
			<h1
				class="mt-4 text-[clamp(2.5rem,7vw,5rem)] leading-[1.05] font-extrabold tracking-tight text-balance"
			>
				{heading}
			</h1>
			<div class="mt-10 flex flex-wrap justify-center gap-3">
				<a href="/" class="pill pill-sm font-medium">Back to the home page</a>
				{#if extension}
					<a href={links.extensions} class="ghost">All extensions</a>
				{:else}
					<a href={links.docs} class="ghost">
						Read the docs <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
					</a>
				{/if}
			</div>
		</main>
	</div>

	<hr class="h-1 border-0 bg-blush" />
	<Footer />
</div>

<style>
	.ghost {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border-radius: 8px;
		padding: 10px 14px;
		font-size: 1rem;
		font-weight: 500;
		color: #fff;
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.4);
		transition: background-color 0.18s ease;
	}

	.ghost:hover {
		background: rgb(255 255 255 / 0.12);
	}

	.ghost:focus-visible {
		outline: 3px solid var(--color-cream);
		outline-offset: 3px;
	}
</style>
