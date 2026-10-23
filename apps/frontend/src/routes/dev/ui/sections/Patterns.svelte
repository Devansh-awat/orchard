<script lang="ts">
	import {
		Ellipsis,
		Globe,
		GitBranch,
		GitCommitHorizontal,
		Plus,
		ExternalLink
	} from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import List from '$lib/components/ui/List.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import MetaList from '$lib/components/ui/MetaList.svelte';
	import Monogram from '$lib/components/ui/Monogram.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import ProjectHero from '$lib/components/patterns/ProjectHero.svelte';
	import ProjectBackdrop from '$lib/components/patterns/ProjectBackdrop.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import { PROJECTS, SIDEBAR, BUILD_FEED } from '../fixtures';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';

	const terra = PROJECTS[1];
	const site = PROJECTS[0];
	const spark = [12, 18, 14, 22, 30, 26, 34, 28, 40, 36, 44, 38, 46, 52, 48, 56];
	const dips = [40, 38, 41, 36, 22, 18, 30, 34, 12, 9, 14, 8];
</script>

<div class="grid grid-cols-3 gap-6">
	<div class="flex flex-col gap-3">
		<SectionTitle title="Sidebar" />
		<div class="sidebar-demo">
			<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} sections={SIDEBAR.sections('apps')} />
		</div>
	</div>
	<div class="col-span-2 flex flex-col gap-6">
		<div class="flex flex-col gap-3">
			<SectionTitle title="Section title" />
			<Card>
				<div class="flex flex-col gap-4">
					<SectionTitle title="Recent builds" count={12} />
					<SectionTitle title="Usage" size="md">
						{#snippet actions()}<Button size="sm" variant="ghost">View all</Button>{/snippet}
					</SectionTitle>
				</div>
			</Card>
		</div>
		<div class="flex flex-col gap-3">
			<SectionTitle title="Meta list" />
			<Card>
				<MetaList
					items={[
						{ icon: Globe, label: 'worker-arcade-leaderboard.orchard.my', href: '#' },
						{ icon: GitBranch, label: 'main' },
						{ icon: GitCommitHorizontal, label: '9c41e0b', mono: true },
						{ label: 'Deployed 12m ago' }
					]}
				>
					{#snippet leading()}<StatusBadge meta={resourceStatus('crashing')} />{/snippet}
				</MetaList>
			</Card>
		</div>
		<div class="flex flex-col gap-3">
			<SectionTitle title="Sparkline and metric" />
			<div class="grid grid-cols-2 gap-3">
				<Card>
					<Metric label="Requests" value="3.1k" detail="last 24h">
						{#snippet chart()}<Sparkline values={spark} />{/snippet}
					</Metric>
				</Card>
				<Card>
					<Metric label="Free memory" value="9" unit="MB" detail="of 512 MB" tone="error">
						{#snippet chart()}<Sparkline values={dips} tone="error" />{/snippet}
					</Metric>
				</Card>
			</div>
		</div>
		<div class="flex flex-col gap-3">
			<SectionTitle title="Monogram" />
			<Card>
				<div class="flex items-center gap-3">
					{#each ['hackclub-site', 'arcade', 'summer-of-making', 'bank', 'terra'] as n (n)}
						<Monogram name={n} />
					{/each}
					{#each ['hackclub-site', 'arcade', 'summer-of-making', 'bank', 'terra'] as n (n)}
						<Monogram name={n} size="sm" />
					{/each}
				</div>
			</Card>
		</div>
	</div>
</div>

<div class="flex flex-col gap-3">
	<SectionTitle title="Project group with entity cards" />
	<ProjectGroup
		name={terra.name}
		href="#"
		image={terra.image}
		background={terra.background}
		owner={terra.owner}
		counts={terra.counts}
		updatedAt={terra.entities[0].updatedAt}
		summary={{ tone: 'error', label: '1 failing' }}
		onNew={() => {}}
	>
		{#each terra.entities.concat(site.entities.slice(0, 1)) as e (e.name)}
			<EntityCard
				kind={e.kind}
				name={e.name}
				status={e.status}
				detail={e.url ?? e.detail}
				metrics={e.metrics}
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
						<MenuItem danger>Delete</MenuItem>
					</Menu>
				{/snippet}
			</EntityCard>
		{/each}
	</ProjectGroup>
</div>

<div class="flex flex-col gap-3">
	<SectionTitle title="Widgets: needs attention, recent builds" />
	<div class="grid grid-cols-3 items-start gap-4">
		<NeedsAttention items={SIDEBAR.failing} />
		<RecentBuilds builds={BUILD_FEED} />
		<RecentBuilds builds={BUILD_FEED.slice(1)} />
	</div>
</div>

<div class="flex flex-col gap-3">
	<SectionTitle title="Entity rows" />
	<List>
		{#each site.entities as e (e.name)}
			<EntityRow {...e} href="#" />
		{/each}
	</List>
</div>

<div class="flex flex-col gap-3">
	<SectionTitle title="Project hero over its aura" />
	<div class="hero-demo">
		<ProjectBackdrop name={terra.name} image={terra.background} />
		<div class="hero-inner">
			<ProjectHero name={terra.name} image={terra.image} meta="12 apps · 4 members">
				{#snippet eyebrow()}Hack Club{/snippet}
				{#snippet actions()}
					<Button icon={Plus}>New</Button>
					<Button variant="primary" iconRight={ExternalLink}>Visit</Button>
				{/snippet}
			</ProjectHero>
		</div>
	</div>
</div>

<style>
	.sidebar-demo {
		height: 34rem;
	}
	.hero-demo {
		position: relative;
		height: 16rem;
		border-radius: var(--radius-panel);
		background: var(--bg-app);
		box-shadow: var(--shadow-raised);
		overflow: hidden;
		isolation: isolate;
	}
	.hero-inner {
		position: relative;
		z-index: 1;
	}
</style>
