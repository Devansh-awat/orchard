<script lang="ts">
	import { reveal } from '$lib/motion.svelte';
	import Shot from './Shot.svelte';
	import { Globe, CalendarClock, Terminal, Layers, Bell, History } from 'lucide-svelte';

	const small = [
		{
			icon: Layers,
			title: 'Environments and variables',
			body: 'Separate production from the rest and share variables across a project. Secrets are encrypted at rest and write-only in the UI.'
		},
		{
			icon: Bell,
			title: 'Notifications',
			body: 'Route deploy and crash events to Slack, Discord, or a webhook, for one app or the whole organization.'
		},
		{
			icon: History,
			title: 'Rollbacks',
			body: 'Every build is kept. Roll back to any earlier image from the deploy history in one click.'
		}
	];

	const also = [
		'Persistent volumes',
		'Metrics and crash reports',
		'Teams, roles, and audit logs',
		'SAML and OIDC sign-in',
		'SCIM provisioning',
		'Deployment protection',
		'Compose stacks',
		'Templates',
		'Node pools and quotas',
		'Command-K search'
	];
</script>

<section id="platform" class="section-y scroll-mt-16">
	<div class="section-x">
		<div>
			<h2
				{@attach reveal()}
				class="max-w-[24ch] text-4xl font-semibold tracking-tight text-balance text-ink-900 md:text-5xl"
			>
				Everything around your app, handled.
			</h2>
			<p {@attach reveal({ index: 1 })} class="mt-5 max-w-[48ch] text-lg text-pretty text-ink-700">
				Deploying is the start. Orchard runs the parts you would otherwise duct-tape together.
			</p>
		</div>

		<dl class="mt-14 grid gap-8 md:grid-cols-6 md:gap-6">
			<div {@attach reveal({ index: 2 })} class="tile overflow-hidden md:col-span-4">
				<div class="p-8">
					<dt class="text-xl font-semibold tracking-tight text-ink-900">Databases included</dt>
					<dd class="mt-2 max-w-[52ch] text-pretty text-ink-700">
						One-click PostgreSQL that lives next to your app. Backups, extensions, a query console,
						and connection strings in four formats.
					</dd>
				</div>
				<Shot name="database" alt="" class="mx-8 !rounded-t-xl !rounded-b-none" />
			</div>

			<div
				{@attach reveal({ index: 3 })}
				class="tile flex flex-col justify-center p-8 md:col-span-2"
			>
				<Globe size={22} strokeWidth={1.5} class="text-primary-500" aria-hidden="true" />
				<dt class="mt-4 text-xl font-semibold tracking-tight text-ink-900">Domains and HTTPS</dt>
				<dd class="mt-2 text-pretty text-ink-700">
					Point DNS at Orchard. It validates the records, issues the certificate, and renews it
					without asking.
				</dd>
			</div>

			<div
				{@attach reveal({ index: 4 })}
				class="panel-surface overflow-hidden rounded-2xl md:col-span-3"
			>
				<div class="p-8">
					<Terminal size={22} strokeWidth={1.5} class="text-primary-300" aria-hidden="true" />
					<dt class="mt-4 text-xl font-semibold tracking-tight text-primary-50">
						Logs and a shell
					</dt>
					<dd class="mt-2 max-w-[46ch] text-pretty text-primary-100/70">
						Stream logs as they happen, filter by pod and time range, or open a shell inside the
						running container.
					</dd>
				</div>
			</div>

			<div
				{@attach reveal({ index: 5 })}
				class="tile flex flex-col justify-center p-8 md:col-span-3"
			>
				<CalendarClock size={22} strokeWidth={1.5} class="text-primary-500" aria-hidden="true" />
				<dt class="mt-4 text-xl font-semibold tracking-tight text-ink-900">Jobs and pipelines</dt>
				<dd class="mt-2 max-w-[46ch] text-pretty text-ink-700">
					Cron schedules and multi-step runs on the cluster, with per-step logs and exit codes you
					can read.
				</dd>
			</div>

			{#each small as feature (feature.title)}
				{@const Icon = feature.icon}
				<div {@attach reveal({ index: 6 })} class="tile p-8 md:col-span-2">
					<Icon size={22} strokeWidth={1.5} class="text-primary-500" aria-hidden="true" />
					<dt class="mt-4 text-lg font-semibold tracking-tight text-ink-900">
						{feature.title}
					</dt>
					<dd class="mt-2 text-pretty text-ink-700">{feature.body}</dd>
				</div>
			{/each}
		</dl>

		<div {@attach reveal({ index: 7 })} class="hairline-t mt-12 pt-6">
			<h3 class="font-mono text-sm tracking-wide text-ink-500 uppercase">Also included</h3>
			<ul role="list" class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-ink-700">
				{#each also as item (item)}
					<li>{item}</li>
				{/each}
			</ul>
		</div>
	</div>
</section>
