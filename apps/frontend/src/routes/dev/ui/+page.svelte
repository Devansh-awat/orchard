<script lang="ts">
	import DevBar from './DevBar.svelte';
	import AppFrame from '$lib/components/patterns/AppFrame.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import { SIDEBAR } from './fixtures';
	import { SECTIONS } from './sections';

	const groups = [...new Set(SECTIONS.map((s) => s.group))];
	let current = $state(SECTIONS[0].id);
	const sections = $derived(
		groups.map((group) => ({
			label: group,
			items: SECTIONS.filter((s) => s.group === group).map((s) => ({
				label: s.title,
				href: `#${s.id}`,
				active: current === s.id
			}))
		}))
	);

	function track(node: HTMLElement) {
		const io = new IntersectionObserver(
			(entries) => {
				const hit = entries.find((e) => e.isIntersecting);
				if (hit) current = hit.target.id;
			},
			{ rootMargin: '-10% 0px -80% 0px' }
		);
		for (const el of node.querySelectorAll('section[id]')) io.observe(el);
		return () => io.disconnect();
	}
</script>

<AppFrame>
	{#snippet sidebar()}
		<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} {sections} />
	{/snippet}

	<div class="catalogue" {@attach track}>
		<header class="flex flex-col gap-1">
			<h1 class="text-title-1 text-fg">Orchard UI</h1>
			<p class="text-body text-muted">
				Every piece of the app, in every state. If it is not here, it does not exist yet.
			</p>
		</header>
		{#each SECTIONS as s (s.id)}
			{@const Body = s.component}
			<section id={s.id} class="flex scroll-mt-8 flex-col gap-4">
				<h2 class="text-title-3 text-fg">{s.title}</h2>
				<Body />
			</section>
		{/each}
	</div>
</AppFrame>

<DevBar />

<style>
	.catalogue {
		display: flex;
		flex-direction: column;
		gap: 3rem;
		max-width: 72rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 8rem;
	}
</style>
