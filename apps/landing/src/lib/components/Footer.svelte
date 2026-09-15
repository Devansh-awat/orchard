<script lang="ts">
	import Logo from './Logo.svelte';
	const groups = [
		{
			title: 'Platform',
			links: [
				{ href: 'https://docs.orchard.my', label: 'Documentation' },
				{ href: '#how', label: 'How it works' },
				{ href: '#platform', label: 'Features' },
				{ href: '#agents', label: 'MCP for agents' },
				{ href: '#cli', label: 'CLI' }
			]
		},
		{
			title: 'Self-host',
			links: [
				{ href: '#self-host', label: 'Run your own' },
				{ href: 'https://github.com/hackclub/orchard', label: 'Source' },
				{ href: 'https://github.com/hackclub/orchard/blob/main/LICENSE', label: 'License' }
			]
		},
		{
			title: 'Get started',
			links: [
				{ href: 'https://docs.orchard.my/start/install/', label: 'Install guide' },
				{ href: 'https://docs.orchard.my/mcp/', label: 'MCP setup' },
				{ href: 'https://docs.orchard.my/reference/cli/', label: 'CLI reference' }
			]
		}
	];
</script>

<footer class="hairline-t">
	<div class="section-x py-14">
		<div class="grid gap-10 md:grid-cols-12 md:gap-6">
			<div class="md:col-span-5">
				<Logo />
				<p class="mt-4 max-w-[36ch] text-pretty text-ink-500">Deploy something you're proud of.</p>
				<p class="mt-4 text-pretty text-ink-700">
					A Hack Club project created by
					<a
						href="https://github.com/LeafdTK"
						class="font-medium text-ink-900 underline decoration-primary-300 underline-offset-4 transition-colors hover:decoration-primary-500"
					>
						Leafd
					</a>.
				</p>
			</div>
			{#each groups as group (group.title)}
				<div class="md:col-span-2 last:md:col-span-3">
					<h2 class="text-sm font-semibold text-ink-900">{group.title}</h2>
					<ul role="list" class="mt-4 flex flex-col gap-2.5">
						{#each group.links as link (link.label)}
							<li>
								<a href={link.href} class="text-ink-700 transition-colors hover:text-ink-900">
									{link.label}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
		<p class="hairline-t mt-12 pt-6 text-sm text-ink-500">
			AGPL-3.0. Built on Kubernetes, by people who got tired of writing YAML.
		</p>
	</div>
</footer>
