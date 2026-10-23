<script lang="ts">
	import { Plus, Ellipsis } from 'lucide-svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import EntityLine from '$lib/components/patterns/EntityLine.svelte';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import { PROJECTS, SIDEBAR, BUILD_FEED, MORE_PROJECTS } from '../fixtures';
	import { exp } from './experiments.svelte';

	type Entity = {
		kind: 'deployment' | 'database' | 'job';
		name: string;
		status: (typeof PROJECTS)[number]['entities'][number]['status'];
		url?: string;
		detail?: string;
		metrics?: string;
		updatedAt?: string;
	};

	const ALL = [
		...PROJECTS.map((p) => ({ ...p, updatedAt: p.entities[0].updatedAt })),
		...MORE_PROJECTS.map((p) => ({ ...p, background: null, entities: p.entities ?? [] }))
	] as {
		id: string;
		name: string;
		image: string | null;
		background: string | null;
		owner: string;
		counts: string[];
		updatedAt: string;
		entities: Entity[];
	}[];

	function summarize(kinds: string[]) {
		const failing = kinds.filter((k) => k === 'error').length;
		const building = kinds.filter((k) => k === 'progress').length;
		if (failing) return { tone: 'error' as const, label: `${failing} failing` };
		if (building) return { tone: 'progress' as const, label: `${building} building` };
		return { tone: 'success' as const, label: 'All running' };
	}

	function traffic(name: string) {
		const seed = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
		let h = seed;
		const values = Array.from({ length: 24 }, (_, i) => {
			h = (h * 1103515245 + 12345) >>> 0;
			return 40 + Math.sin(i / 3 + name.length) * 18 + (h % 23);
		});
		const perHour = Math.round(values.reduce((a, b) => a + b, 0) * ((seed % 40) / 7 + 0.2));
		return {
			values,
			label: perHour > 999 ? `${(perHour / 1000).toFixed(1)}k/h` : `${perHour}/h`
		};
	}

	$effect(() => {
		document.documentElement.dataset.wallpaper = exp.wallpaper;
		return () => delete document.documentElement.dataset.wallpaper;
	});
</script>

{#snippet sideColumn()}
	<div class="side">
		<NeedsAttention items={SIDEBAR.failing} />
		<RecentBuilds builds={BUILD_FEED} />
	</div>
{/snippet}

{#snippet appCard(e: Entity)}
	{#if exp.density === 'compact'}
		<EntityLine
			kind={e.kind}
			name={e.name}
			status={e.status}
			detail={e.url ?? e.detail}
			metrics={e.metrics}
			traffic={exp.cardMetrics === 'spark' && e.kind === 'deployment' ? traffic(e.name) : undefined}
			updatedAt={e.updatedAt}
			href="#"
		/>
	{:else if exp.appLayout === 'rows'}
		<EntityRow
			kind={e.kind}
			name={e.name}
			status={e.status}
			url={e.url}
			detail={e.url ? undefined : e.detail}
			updatedAt={e.updatedAt}
			href="#"
		/>
	{:else}
		<EntityCard
			kind={e.kind}
			name={e.name}
			status={e.status}
			detail={e.url ?? e.detail}
			metrics={e.metrics}
			traffic={exp.cardMetrics === 'spark' && e.kind === 'deployment' ? traffic(e.name) : undefined}
			updatedAt={e.updatedAt}
			href="#"
		>
			{#snippet actions()}
				<Menu>
					{#snippet trigger(props)}<Button
							{...props}
							size="sm"
							variant="ghost"
							icon={Ellipsis}
							label="Actions"
						/>{/snippet}
					<MenuItem>Redeploy</MenuItem>
					<MenuItem>Copy URL</MenuItem>
					<MenuItem danger>Delete</MenuItem>
				</Menu>
			{/snippet}
		</EntityCard>
	{/if}
{/snippet}

<Page title="Your Apps" width="wide" aside={exp.aside === 'off' ? undefined : sideColumn}>
	{#snippet actions()}
		<SearchField placeholder="Search apps" shortcut="/" />
		<Button variant="primary" icon={Plus}>New</Button>
	{/snippet}

	<div class="projects projects--{exp.density}">
		{#each ALL as project (project.id)}
			<ProjectGroup
				name={project.name}
				href="#"
				image={project.image}
				background={project.background}
				owner={project.owner}
				counts={project.counts}
				updatedAt={project.updatedAt}
				summary={summarize(project.entities.map((e) => e.status.kind))}
				onNew={() => {}}
				expanded={project.id === 'p1'}
				density={exp.density as 'regular' | 'compact'}
				layout={exp.density === 'compact' ? 'lines' : (exp.appLayout as 'cards' | 'dense' | 'rows')}
			>
				{#each project.entities as e (e.name)}{@render appCard(e)}{/each}
			</ProjectGroup>
		{/each}
	</div>
</Page>

<style>
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.projects {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.projects--compact {
		gap: 0.5rem;
	}
	:global(html[data-wallpaper='off'] body::before) {
		opacity: 0;
	}
	:global(html[data-wallpaper='rich'] body::before) {
		opacity: 1;
	}
</style>
