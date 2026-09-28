<script lang="ts">
	import { links } from '$lib/links';
	import { hover, reveal } from '$lib/motion.svelte';
</script>

<section
	class="shell flex flex-col items-center pt-[clamp(2.5rem,3.7vw,56px)] pb-[clamp(3rem,4.6vw,64px)]"
>
	<h2
		{@attach reveal()}
		class="text-center text-[clamp(1.75rem,3.9vw,3rem)] leading-[1.26] text-pretty text-white"
	>
		your <span class="font-extrabold">own</span> cloud, in
		<em class="pr-[0.04em] font-extrabold">one</em> click.
	</h2>
	<p
		{@attach reveal({ index: 1 })}
		class="mt-3 text-center text-[clamp(1.0625rem,1.5vw,1.25rem)] font-medium text-white"
	>
		Free and open source. Runs on any Linux box.
	</p>
	<a
		href={links.install}
		{@attach reveal({ index: 2 })}
		{@attach hover()}
		class="pill pill-lg mt-8"
	>
		Install Orchard
	</a>
</section>
