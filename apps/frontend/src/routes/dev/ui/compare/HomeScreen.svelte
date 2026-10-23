<script lang="ts">
	import { Plus, Ellipsis } from 'lucide-svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import UpNextShelf from '$lib/components/patterns/UpNextShelf.svelte';
	import AppDock from '$lib/components/patterns/AppDock.svelte';
	import HomeSpotlight from '$lib/components/patterns/HomeSpotlight.svelte';
	import ProjectTiles from '$lib/components/patterns/ProjectTiles.svelte';
	import ProjectInsetList from '$lib/components/patterns/ProjectInsetList.svelte';
	import { UP_NEXT, PINNED, SPOTLIGHT, TILE_PROJECTS } from '../home-fixtures';
	import FleetSummary from '$lib/components/patterns/FleetSummary.svelte';
	import ResourcesWidget from '$lib/components/patterns/ResourcesWidget.svelte';
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

	const STATS = {
		running: 14,
		total: 17,
		building: 1,
		failing: 2,
		deploysToday: 23,
		deploysFailedToday: 1,
		cpu: { used: 3.2, limit: 8 },
		memory: { usedGiB: 9.4, limitGiB: 16 },
		requests24h: [
			41, 38, 33, 29, 27, 31, 44, 62, 88, 97, 104, 112, 109, 118, 121, 116, 108, 99, 93, 87, 76, 64,
			55, 47
		]
	};

	const RESOURCES = {
		cpu: {
			limit: 8,
			parts: [
				{ label: 'flavortown', value: 1.4 },
				{ label: 'hackclub-site', value: 0.9 },
				{ label: 'terra', value: 0.6 },
				{ label: 'Mercury', value: 0.3 }
			]
		},
		memory: {
			limit: 16,
			parts: [
				{ label: 'flavortown', value: 4.1 },
				{ label: 'hackclub-site', value: 2.6 },
				{ label: 'terra', value: 1.9 },
				{ label: 'Mercury', value: 0.8 }
			]
		}
	};

	const today = new Intl.DateTimeFormat('en', {
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(new Date());

	$effect(() => {
		document.documentElement.dataset.wallpaper = exp.wallpaper;
		return () => delete document.documentElement.dataset.wallpaper;
	});
</script>

{#snippet sideColumn()}
	<div class="side">
		<NeedsAttention items={SIDEBAR.failing} />
		<RecentBuilds builds={BUILD_FEED} />
		{#if exp.aside === 'resources'}<ResourcesWidget {...RESOURCES} />{/if}
	</div>
{/snippet}

{#snippet eyebrow()}
	{exp.eyebrow === 'date' ? today : `${SIDEBAR.org.name} · ${SIDEBAR.org.plan}`}
{/snippet}

{#snippet appCard(e: Entity)}
	{#if exp.appLayout === 'rows'}
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

<Page
	title="Your Apps"
	width="wide"
	eyebrow={exp.eyebrow === 'off' ? undefined : eyebrow}
	aside={exp.aside === 'off' ? undefined : sideColumn}
>
	{#snippet actions()}
		{#if exp.search === 'header'}
			<SearchField placeholder="Search apps" shortcut="/" />
		{/if}
		<Button variant="primary" icon={Plus}>New</Button>
	{/snippet}

	{#if exp.search === 'wide'}
		<div class="wide-search">
			<SearchField placeholder="Search apps, deployments, databases and logs" shortcut="⌘K" />
		</div>
	{/if}

	{#if exp.summary !== 'off'}
		<FleetSummary variant={exp.summary as 'numbers' | 'rings' | 'sentence'} stats={STATS} />
	{/if}

	{#if exp.hero !== 'off'}
		<HomeSpotlight items={SPOTLIGHT} variant={exp.hero as 'spotlight' | 'banner'} />
	{/if}

	{#if exp.upNext === 'shelf'}
		<UpNextShelf items={UP_NEXT} seeAllHref="#" />
	{:else if exp.upNext === 'dock'}
		<AppDock items={PINNED} />
	{/if}

	{#if exp.sectionHeads === 'on'}
		<SectionTitle title="Projects" count={ALL.length} size="md" />
	{/if}

	{#if exp.projects === 'tiles'}
		<ProjectTiles projects={TILE_PROJECTS} />
	{:else if exp.projects === 'list'}
		<ProjectInsetList projects={TILE_PROJECTS} />
	{:else}
		<div class="projects">
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
					layout={exp.appLayout as 'cards' | 'dense' | 'rows'}
				>
					{#each project.entities as e (e.name)}{@render appCard(e)}{/each}
				</ProjectGroup>
			{/each}
		</div>
	{/if}
</Page>

<style>
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.wide-search :global(.search) {
		height: 2.75rem;
		padding-left: 1rem;
		border-radius: calc(0.875rem * var(--corner-scale));
	}
	.projects {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	:global(html[data-wallpaper='off'] body::before) {
		opacity: 0;
	}
	:global(html[data-wallpaper='rich'] body::before) {
		opacity: 1;
	}
</style>
