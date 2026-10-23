<script lang="ts">
	import { Plus } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import SpotlightSearch, {
		type SpotlightItem
	} from '$lib/components/patterns/SpotlightSearch.svelte';
	import DevBar from '../../DevBar.svelte';
	import { PROJECTS, MORE_PROJECTS } from '../../fixtures';

	const ALL = [...PROJECTS, ...MORE_PROJECTS];

	const items: SpotlightItem[] = ALL.flatMap((p) => [
		{
			id: p.id,
			label: p.name,
			sublabel: p.counts.join(' · '),
			kind: 'project' as const,
			icon: p.image,
			href: `#${p.id}`
		},
		...p.entities.map((e) => ({
			id: `${p.id}-${e.name}`,
			label: e.name,
			sublabel: p.name,
			kind: e.kind,
			status: e.status,
			href: `#${p.id}-${e.name}`
		}))
	]);

	let picked = $state<SpotlightItem | null>(null);
</script>

<div class="lab">
	<header class="head">
		<h1 class="title">Your Apps</h1>
		<div class="actions">
			<SpotlightSearch {items} onSelect={(item) => (picked = item)} />
			<Button variant="primary" icon={Plus}>New</Button>
		</div>
	</header>

	{#if picked}
		<p class="picked">Opened {picked.label}</p>
	{/if}

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
</div>

<DevBar />

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		max-width: var(--page-wide);
		margin: 0 auto;
		padding: 1.5rem 2rem 6rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 2.5rem;
	}
	.title {
		font-size: var(--text-title-2);
		font-weight: var(--weight-semibold);
		color: var(--text-default);
		text-box: trim-both cap alphabetic;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.picked {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.project {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
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
