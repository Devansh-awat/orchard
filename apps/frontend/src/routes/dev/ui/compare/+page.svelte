<script lang="ts">
	import {
		Plus,
		Ellipsis,
		ExternalLink,
		RotateCw,
		GitBranch,
		GitCommitHorizontal,
		Globe,
		Lock
	} from 'lucide-svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import ToggleRow from '$lib/components/ui/ToggleRow.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import DevBar from '../DevBar.svelte';
	import AppFrame from '$lib/components/patterns/AppFrame.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import MetaList from '$lib/components/ui/MetaList.svelte';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import ProjectHero from '$lib/components/patterns/ProjectHero.svelte';
	import ProjectBackdrop from '$lib/components/patterns/ProjectBackdrop.svelte';
	import { PROJECTS, BUILDS, SIDEBAR, BUILD_FEED } from '../fixtures';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';

	let screen = $state('home');
	let feed = $state<'grouped' | 'widget' | 'stack' | 'shelf'>('grouped');
	let tab = $state<'overview' | 'logs' | 'metrics' | 'env' | 'settings'>('overview');
	let range = $state('day');
	let appName = $state('hackclub-site');
	let branch = $state('main');
	let autoDeploy = $state(true);
	let previews = $state(false);
	let protectPreviews = $state(true);

	const spark = [12, 18, 14, 22, 30, 26, 34, 28, 40, 36, 44, 38, 46, 52, 48, 56];
	const sections = $derived(SIDEBAR.sections(screen === 'settings' ? 'settings' : 'apps'));
</script>

<div class="switcher">
	<SegmentedControl
		label="Screen"
		bind:value={screen}
		options={[
			{ value: 'home', label: 'Org home' },
			{ value: 'project', label: 'Project' },
			{ value: 'deployment', label: 'Deployment' },
			{ value: 'settings', label: 'Settings' }
		]}
	/>
</div>

<AppFrame>
	{#snippet sidebar()}
		<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} failing={SIDEBAR.failing} {sections} />
	{/snippet}
	{#snippet backdrop()}
		{#if screen === 'project'}<ProjectBackdrop name="terra" image={PROJECTS[1].background} />{/if}
	{/snippet}
	{#if screen === 'home'}
		<Page title="Apps" width="wide">
			{#snippet actions()}
				<SearchField placeholder="Search apps" shortcut="/" class="w-64" />
				<Button variant="primary" icon={Plus}>New</Button>
			{/snippet}
			{#snippet aside()}
				<div class="flex flex-col gap-4">
					<SegmentedControl
						label="Recent builds style"
						size="sm"
						grow
						bind:value={feed}
						options={[
							{ value: 'grouped', label: 'Grouped' },
							{ value: 'widget', label: 'Widget' },
							{ value: 'stack', label: 'Stack' },
							{ value: 'shelf', label: 'Shelf' }
						]}
					/>
					<RecentBuilds builds={BUILD_FEED} variant={feed} />
				</div>
			{/snippet}

			{#each PROJECTS as project (project.id)}
				<ProjectGroup
					name={project.name}
					href="#"
					image={project.image}
					background={project.background}
					owner={project.owner}
					counts={project.counts}
					updatedAt={project.entities[0].updatedAt}
					live={project.entities.filter((e) => e.status.kind === 'success').length}
					onNew={() => {}}
				>
					{#each project.entities as e (e.name)}
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
									<MenuItem>Copy URL</MenuItem>
									<MenuItem danger>Delete</MenuItem>
								</Menu>
							{/snippet}
						</EntityCard>
					{/each}
				</ProjectGroup>
			{/each}
		</Page>
	{:else if screen === 'project'}
		<Page title="terra" width="wide">
			{#snippet hero()}
				<ProjectHero name="terra" image={PROJECTS[1].image} meta="12 apps · 4 members">
					{#snippet eyebrow()}Hack Club{/snippet}
					{#snippet actions()}
						<Button icon={Plus}>New</Button>
						<Button variant="primary" iconRight={ExternalLink}>Visit</Button>
					{/snippet}
				</ProjectHero>
			{/snippet}
			{#snippet aside()}
				<RecentBuilds builds={BUILD_FEED} variant={feed} />
			{/snippet}
			<List label="Resources">
				{#each PROJECTS[0].entities.concat(PROJECTS[1].entities) as e (e.name)}
					<EntityRow {...e} href="#" />
				{/each}
			</List>
		</Page>
	{:else if screen === 'deployment'}
		<Page title="worker" width="wide">
			{#snippet eyebrow()}arcade-leaderboard{/snippet}
			{#snippet actions()}
				<Button iconRight={ExternalLink}>Visit</Button>
				<Button variant="primary" icon={RotateCw}>Redeploy</Button>
				<Menu>
					{#snippet trigger(props)}<Button {...props} icon={Ellipsis} label="More" />{/snippet}
					<MenuItem>Restart</MenuItem>
					<MenuItem>Roll back</MenuItem>
					<MenuItem danger>Delete deployment</MenuItem>
				</Menu>
			{/snippet}

			<div class="flex flex-col gap-4">
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
				<Tabs
					bind:value={tab}
					tabs={[
						{ id: 'overview', label: 'Overview' },
						{ id: 'logs', label: 'Logs' },
						{ id: 'metrics', label: 'Metrics' },
						{ id: 'env', label: 'Environment' },
						{ id: 'settings', label: 'Settings' }
					]}
				/>
			</div>

			<Alert tone="error" title="worker keeps running out of memory">
				It was killed 4 times in the last hour at 512 MB. Raise the limit or reduce memory use.
				{#snippet actions()}<Button size="sm">Raise to 1 GB</Button>{/snippet}
			</Alert>

			<SectionTitle title="Usage" size="md">
				{#snippet actions()}
					<SegmentedControl
						label="Range"
						size="sm"
						bind:value={range}
						options={[
							{ value: 'hour', label: '1h' },
							{ value: 'day', label: '24h' },
							{ value: 'week', label: '7d' }
						]}
					/>
				{/snippet}
			</SectionTitle>
			<div class="grid grid-cols-4 gap-3">
				<Card><Metric label="CPU" value="0.18" unit="cores" detail="of 0.5" /></Card>
				<Card
					><Metric label="Memory" value="508" unit="MB" detail="99% of 512 MB" tone="error" /></Card
				>
				<Card>
					<Metric label="Requests" value="3.1k" detail="last 24h">
						{#snippet chart()}<Sparkline values={spark} label="Requests over 24 hours" />{/snippet}
					</Metric>
				</Card>
				<Card><Metric label="Replicas" value="0/1" detail="restarting" tone="warning" /></Card>
			</div>

			<div class="grid grid-cols-2 gap-6">
				<SectionCard title="Latest build" flush>
					{#snippet actions()}<Button size="sm" variant="ghost">All builds</Button>{/snippet}
					<List inset={false}>
						{#each BUILDS.slice(0, 3) as b (b.id)}
							<ListRow title={b.commit} href="#">
								{#snippet leading()}<StatusDot meta={b.status} />{/snippet}
								{#snippet subtitle()}{b.name} · 41s{/snippet}
								{#snippet trailing()}<RelativeTime date={b.at} />{/snippet}
							</ListRow>
						{/each}
					</List>
				</SectionCard>
				<SectionCard title="Domains" flush>
					{#snippet actions()}<Button size="sm" variant="ghost" icon={Plus}>Add</Button>{/snippet}
					<List inset={false}>
						<ListRow title="worker-arcade-leaderboard.orchard.my">
							{#snippet leading()}<Globe size={16} class="text-muted" />{/snippet}
							{#snippet subtitle()}Orchard domain · TLS{/snippet}
							{#snippet actions()}<CopyButton
									value="worker-arcade-leaderboard.orchard.my"
								/>{/snippet}
						</ListRow>
						<ListRow title="leaderboard.hackclub.com">
							{#snippet leading()}<Lock size={16} class="text-muted" />{/snippet}
							{#snippet titleSuffix()}<Badge tone="warning">DNS pending</Badge>{/snippet}
							{#snippet subtitle()}CNAME to edge.orchard.my{/snippet}
						</ListRow>
					</List>
				</SectionCard>
			</div>
		</Page>
	{:else}
		<Page title="Settings" description="hackclub-site / web" width="narrow">
			<SectionCard title="General">
				<div class="flex flex-col gap-4">
					<Field label="Name" hint="Used in the URL and the CLI." for="s-name">
						<Input id="s-name" bind:value={appName} />
					</Field>
					<Field label="Production branch" for="s-branch">
						<Select id="s-branch" bind:value={branch}>
							<option value="main">main</option>
							<option value="production">production</option>
						</Select>
					</Field>
				</div>
				{#snippet footer()}<Button variant="primary" size="sm">Save</Button>{/snippet}
			</SectionCard>

			<SectionCard title="Git">
				<div class="flex flex-col gap-4">
					<ToggleRow
						label="Deploy on push"
						hint="Every push to main builds and ships."
						bind:checked={autoDeploy}
					/>
					<ToggleRow
						label="Preview deployments"
						hint="Each pull request gets its own URL."
						bind:checked={previews}
					/>
					<ToggleRow
						label="Protect previews"
						hint="Only org members can open preview URLs."
						bind:checked={protectPreviews}
						disabled={!previews}
					/>
				</div>
			</SectionCard>

			<SectionCard
				title="Danger zone"
				description="Deleting web stops every replica and frees its domains."
			>
				{#snippet footer()}<Button variant="danger" size="sm">Delete web</Button>{/snippet}
			</SectionCard>
		</Page>
	{/if}
</AppFrame>

<DevBar />

<style>
	.switcher {
		position: fixed;
		bottom: 1.375rem;
		left: 1rem;
		z-index: var(--z-nav);
	}
</style>
