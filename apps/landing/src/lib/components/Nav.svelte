<script lang="ts">
	import { Menu, X } from 'lucide-svelte';
	import Logo from './Logo.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	const links = [
		{ href: '#how', label: 'How it works' },
		{ href: '#platform', label: 'Platform' },
		{ href: '#agents', label: 'For agents' },
		{ href: '#self-host', label: 'Self-host' },
		{ href: 'https://docs.orchard.my', label: 'Docs' }
	];

	let open = $state(false);
</script>

<nav
	class="fixed inset-x-0 top-0 z-50 border-b border-[var(--hairline)] bg-canvas/85 backdrop-blur-md"
	aria-label="Main"
>
	<div class="section-x flex h-16 items-center">
		<div class="flex flex-1 items-center">
			<a href="/" aria-label="Orchard home" class="rounded-sm focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-4">
				<Logo />
			</a>
		</div>

		<div class="flex items-center gap-8 text-[0.9375rem] font-medium text-ink-700 max-lg:hidden">
			{#each links as link (link.href)}
				<a href={link.href} class="transition-colors hover:text-ink-900">{link.label}</a>
			{/each}
		</div>

		<div class="flex flex-1 items-center justify-end gap-3">
			<a
				href="https://github.com/LeafdTK/leaf"
				class="text-[0.9375rem] font-medium text-ink-700 transition-colors hover:text-ink-900 max-sm:hidden"
			>
				GitHub
			</a>
			<ThemeToggle />
			<a href="https://github.com/LeafdTK/leaf" class="btn btn-md btn-outline max-lg:hidden">Get Orchard</a>
			<button
				type="button"
				onclick={() => (open = !open)}
				aria-expanded={open}
				aria-controls="mobile-nav"
				class="relative -mr-2 rounded-full p-2 text-ink-900 lg:hidden"
			>
				<span class="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
				{#if open}
					<X size={22} strokeWidth={1.75} aria-hidden="true" />
				{:else}
					<Menu size={22} strokeWidth={1.75} aria-hidden="true" />
				{/if}
				<span
					class="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
					aria-hidden="true"
				></span>
			</button>
		</div>
	</div>

	{#if open}
		<div id="mobile-nav" class="border-t border-[var(--hairline)] bg-canvas lg:hidden">
			<ul role="list" class="section-x flex flex-col py-3 text-base">
				{#each links as link (link.href)}
					<li>
						<a
							href={link.href}
							onclick={() => (open = false)}
							class="block py-2.5 font-medium text-ink-700"
						>
							{link.label}
						</a>
					</li>
				{/each}
				<li>
					<a href="https://github.com/LeafdTK/leaf" class="block py-2.5 font-medium text-ink-700">
						GitHub
					</a>
				</li>
				<li class="pt-3 pb-1">
					<a
						href="https://github.com/LeafdTK/leaf"
						class="btn btn-md btn-outline w-full justify-center"
					>
						Get Orchard
					</a>
				</li>
			</ul>
		</div>
	{/if}
</nav>
