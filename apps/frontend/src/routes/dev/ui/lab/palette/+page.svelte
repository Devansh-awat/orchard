<script lang="ts">
	import AppFrame from '$lib/components/patterns/AppFrame.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import CommandPalette from '$lib/components/patterns/CommandPalette.svelte';
	import { PALETTE_ITEMS, paletteActions } from '../../palette-fixtures';
	import Page from '$lib/components/ui/Page.svelte';
	import DevBar from '../../DevBar.svelte';
	import { PROJECTS, MORE_PROJECTS, SIDEBAR } from '../../fixtures';

	const ALL = [...PROJECTS, ...MORE_PROJECTS];
	const sections = SIDEBAR.sections('apps');

	let open = $state(false);
	let frame = $state<HTMLElement>();
	let said = $state<string | null>(null);

	const say = (text: string) => () => (said = text);
	const actions = paletteActions(say);
	const items = PALETTE_ITEMS;

	const origin = () => frame?.querySelector('input[type="search"]')?.closest('label');
</script>

<AppFrame>
	{#snippet sidebar()}
		<div class="side" bind:this={frame}>
			<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} {sections} onSearch={() => (open = true)} />
		</div>
	{/snippet}
	<Page title="Your Apps" width="wide">
		{#if said}<p class="said">{said}</p>{/if}
		{#each ALL as p (p.id)}
			<section class="project">
				<h2 class="project-name">{p.name}</h2>
				<div class="cards">
					{#each p.entities as e (e.name)}
						<EntityCard
							kind={e.kind}
							name={e.name}
							status={e.status}
							detail={e.detail}
							updatedAt={e.updatedAt}
							href="#{p.id}-{e.name}"
						/>
					{/each}
				</div>
			</section>
		{/each}
	</Page>
</AppFrame>

<CommandPalette
	bind:open
	{origin}
	{items}
	{actions}
	onSelect={(item) => (said = `Opened ${item.label}`)}
/>

<DevBar />

<style>
	.side {
		height: 100%;
	}
	.said {
		margin-bottom: 1.5rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.project {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 2rem;
	}
	.project-name {
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
	}
</style>
