<script lang="ts">
	import AsciiVine from './AsciiVine.svelte';
	import { reveal } from '$lib/motion.svelte';

	const points = [
		{
			title: 'Any cluster',
			body: 'A homelab box, a rack, or a cloud account. If it runs Kubernetes, it runs Orchard.'
		},
		{
			title: 'Your hardware, your rules',
			body: 'Node pools, taints, and quotas decide what lands where. Nothing phones home to schedule your workloads.'
		},
		{
			title: 'AGPL, all of it',
			body: 'The web app, the API, the Go gateway, and the CLI. Not an open core with the useful parts held back.'
		}
	];
</script>

<section id="self-host" class="section-y scroll-mt-16 bg-shell-50">
	<div class="section-x grid items-center gap-8 md:gap-6 lg:grid-cols-12">
		<div class="lg:col-span-5">
			<p class="font-mono text-sm tracking-wide text-primary-600 uppercase">Open source soon</p>
			<h2
				{@attach reveal()}
				class="mt-6 max-w-[20ch] text-4xl font-semibold tracking-tight text-balance text-ink-900 md:text-5xl"
			>
				Your cluster, your orchard.
			</h2>
			<p {@attach reveal({ index: 1 })} class="mt-5 max-w-[48ch] text-lg text-pretty text-ink-700">
				Point Orchard at a cluster you control and everyone you invite gets push-to-deploy on your
				hardware.
			</p>

			<ul role="list" class="mt-10 flex flex-col gap-6">
				{#each points as point, i (point.title)}
					<li {@attach reveal({ index: i + 2 })} class="hairline-t pt-4">
						<h3 class="font-semibold text-ink-900">{point.title}</h3>
						<p class="mt-1 max-w-[52ch] text-pretty text-ink-700">{point.body}</p>
					</li>
				{/each}
			</ul>

			<a
				{@attach reveal({ index: 5 })}
				href="https://github.com/LeafdTK/leaf"
				class="btn btn-lg btn-outline mt-10"
			>
				Follow along on GitHub
			</a>
		</div>

		<div
			class="relative min-h-[24rem] panel-surface overflow-hidden rounded-3xl lg:col-span-6 lg:col-start-7 lg:min-h-[34rem]"
			aria-hidden="true"
		>
			<AsciiVine class="absolute inset-0 h-full w-full" seed={19} band={[0.08, 0.96]} />
		</div>
	</div>
</section>
