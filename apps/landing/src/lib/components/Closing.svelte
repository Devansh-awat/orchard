<script lang="ts">
	import { reveal, hover } from '$lib/motion.svelte';
</script>

<section class="section-y">
	<div class="section-x">
		<div class="panel-surface rounded-3xl px-6 py-20 text-center md:px-14 md:py-24">
			<h2
				{@attach reveal()}
				class="mx-auto max-w-[20ch] text-4xl font-semibold tracking-tight text-balance text-primary-50 md:text-5xl"
			>
				Ready when you are.
			</h2>
			<p
				{@attach reveal({ index: 1 })}
				class="mx-auto mt-5 max-w-[48ch] text-lg text-pretty text-primary-100/75"
			>
				Install it on the cluster you already have, invite your team, and push.
			</p>
			<div
				{@attach reveal({ index: 2 })}
				class="mt-9 flex flex-wrap items-center justify-center gap-3"
			>
				<a
					href="https://github.com/hackclub/orchard"
					{@attach hover()}
					class="btn btn-lg btn-onpanel"
				>
					Run it on your cluster
				</a>
				<a
					href="https://github.com/hackclub/orchard"
					class="btn btn-lg text-primary-50 outline-1 -outline-offset-1 outline-white/25 hover:bg-white/8"
				>
					Read the source
				</a>
			</div>
		</div>
	</div>
</section>
