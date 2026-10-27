<script lang="ts">
	import { Plus, Ellipsis, ExternalLink, RotateCw, LayoutGrid, List } from 'lucide-svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import EntityLine from '$lib/components/patterns/EntityLine.svelte';
	import LiquidNewButton from '$lib/components/patterns/LiquidNewButton.svelte';
	import LiveIsland, { type IslandActivity } from '$lib/components/patterns/LiveIsland.svelte';
	import SpotlightSearch, {
		type SpotlightItem
	} from '$lib/components/patterns/SpotlightSearch.svelte';
	import Notifier from '$lib/components/patterns/Notifier.svelte';
	import { activity } from '$lib/stores/activity';
	import { toasts } from '$lib/stores/toast';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import { PROJECTS, SIDEBAR, BUILD_FEED, MORE_PROJECTS } from '../fixtures';
	import { tick } from 'svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import { backgroundHeld, droplet } from '$lib/utils/motion.svelte';
	import { exp, onAction } from './experiments.svelte';

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

	const SEARCH_ITEMS: SpotlightItem[] = ALL.flatMap((p) => [
		{
			id: p.id,
			label: p.name,
			sublabel: p.counts.join(' · '),
			kind: 'project' as const,
			icon: p.image,
			href: '#'
		},
		...p.entities.map((e) => ({
			id: `${p.id}-${e.name}`,
			label: e.name,
			sublabel: p.name,
			kind: e.kind,
			status: e.status,
			href: '#'
		}))
	]);

	function summarize(kinds: string[]) {
		const failing = kinds.filter((k) => k === 'error').length;
		const building = kinds.filter((k) => k === 'progress').length;
		if (failing) return { tone: 'error' as const, label: `${failing} failing` };
		if (building) return { tone: 'progress' as const, label: `${building} building` };
		return { tone: 'success' as const, label: 'All running' };
	}

	function seedSeries(name: string) {
		const seed = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
		let h = seed;
		const values = Array.from({ length: 24 }, (_, i) => {
			h = (h * 1103515245 + 12345) >>> 0;
			return 40 + Math.sin(i / 3 + name.length) * 18 + (h % 23);
		});
		return { values, scale: (seed % 40) / 7 + 0.2, phase: name.length };
	}

	const series = $state<Record<string, ReturnType<typeof seedSeries>>>(
		Object.fromEntries(
			ALL.flatMap((p) => p.entities)
				.filter((e) => e.kind === 'deployment')
				.map((e) => [e.name, seedSeries(e.name)])
		)
	);

	function perHour(v: number, scale: number) {
		const n = Math.round(v * 24 * scale);
		return n > 999 ? `${(n / 1000).toFixed(1)}k/h` : `${n}/h`;
	}

	function traffic(name: string) {
		const s = series[name] ?? seedSeries(name);
		const scale = s.scale;
		return {
			values: s.values,
			label: perHour(s.values[s.values.length - 1], scale),
			format: (v: number) => perHour(v, scale)
		};
	}

	$effect(() => {
		const id = setInterval(() => {
			if (backgroundHeld()) return;
			for (const s of Object.values(series)) {
				const last = s.values[s.values.length - 1];
				s.phase += 0.35;
				const next = Math.max(12, last + Math.sin(s.phase) * 6 + (Math.random() - 0.5) * 9);
				s.values = [...s.values.slice(1), next];
			}
		}, 4000);
		return () => clearInterval(id);
	});

	const DENSITY_KEY = 'orchard-dev-density';
	let density = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem(DENSITY_KEY) === 'compact'
			? 'compact'
			: 'regular'
	);

	let crashed = $state<string[]>([]);
	let arriving = $state<string[]>([]);
	const CRASHING = resourceStatus('crashing');

	const failing = $derived([
		...crashed.map((key) => {
			const name = key.split('/')[1];
			return {
				label: name,
				href: '#',
				reason: 'Crashed, exit code 1',
				kind: 'deployment' as const
			};
		}),
		...SIDEBAR.failing
	]);

	async function crash() {
		const taken = new Set(failing.map((f) => f.label));
		for (const project of ALL) {
			const section = document.querySelector(`[aria-label="${project.name}"]`);
			for (const e of project.entities) {
				const key = `${project.id}/${e.name}`;
				if (e.kind !== 'deployment' || e.status.kind !== 'success' || taken.has(e.name)) continue;
				const el = section?.querySelector<HTMLElement>(`[data-entity="${e.name}"]`);
				if (!el || el.getBoundingClientRect().height === 0) continue;
				crashed = [...crashed, key];
				arriving = [...arriving, e.name];
				await tick();
				const source = el.querySelector('.dot, .status-dot, [data-motion]') ?? el;
				const target = document.querySelector(`[data-attention="${e.name}"]`);
				const land = () => (arriving = arriving.filter((x) => x !== e.name));
				if (exp.failDrop === 'on' && target) droplet(source, target, { onLand: land });
				else land();
				return;
			}
		}
	}

	const LADDER = [
		{ id: 'queue', label: 'Queued' },
		{ id: 'schedule', label: 'Scheduling' },
		{ id: 'clone', label: 'Cloning' },
		{ id: 'build', label: 'Building' },
		{ id: 'push', label: 'Pushing' },
		{ id: 'rollout', label: 'Rolling out' }
	];

	const BUILDS = [
		{
			app: 'api',
			project: 'hackclub-site',
			projectIcon: ALL[0].image,
			message: 'Bump prisma to 6.4',
			detail: 'main'
		},
		{
			app: 'shipwright',
			project: 'flavortown',
			projectIcon: ALL[2]?.image ?? null,
			message: 'Cache ship previews',
			detail: 'main'
		}
	];

	let activities = $state<IslandActivity[]>([]);
	let seq = 0;

	let unified: { id: string; step: number; at: number }[] = [];

	function startUnified(slot: number) {
		const base = BUILDS[slot % BUILDS.length];
		const id = activity.start({
			...base,
			phase: LADDER[0].label,
			phaseId: LADDER[0].id
		});
		unified.push({ id, step: 0, at: Date.now() });
	}

	function finishUnified(status: 'success' | 'error') {
		const run = unified.shift();
		if (!run) return;
		activity.finish(run.id, status, status === 'error' ? 'npm ci exited with code 1' : undefined);
	}

	function startBuild(slot: number) {
		if (exp.island === 'unified') return startUnified(slot);
		const base = BUILDS[slot % BUILDS.length];
		if (activities.some((a) => a.app === base.app && a.status === 'running')) return;
		seq += 1;
		activities.push({
			id: `sim${seq}`,
			...base,
			phase: LADDER[0].label,
			phaseId: LADDER[0].id,
			progress: 0.04,
			status: 'running',
			phases: [{ id: LADDER[0].id, label: LADDER[0].label, ms: 1200, live: true }]
		});
	}

	function finish(status: 'success' | 'error') {
		if (exp.island === 'unified') return finishUnified(status);
		const a = activities.find((x) => x.status === 'running');
		if (!a) return;
		a.phases = (a.phases ?? []).map((p) => ({ ...p, live: false }));
		a.status = status;
		if (status === 'success') a.progress = 1;
		else a.message = 'npm ci exited with code 1';
	}

	$effect(() => {
		const id = setInterval(() => {
			const now = Date.now();
			for (const run of unified) {
				const next = LADDER[run.step + 1];
				if (!next || now - run.at < 2600 + run.step * 900) continue;
				run.step += 1;
				run.at = now;
				activity.update(run.id, { phase: next.label, phaseId: next.id });
			}
			for (const a of activities) {
				if (a.status !== 'running') continue;
				const live = a.phases?.find((p) => p.live);
				if (!live) continue;
				live.ms += 1000;
				const i = LADDER.findIndex((x) => x.id === a.phaseId);
				const next = LADDER[i + 1];
				if (next && live.ms > 2600 + i * 900) {
					live.live = false;
					a.phases = [...(a.phases ?? []), { id: next.id, label: next.label, ms: 400, live: true }];
					a.phase = next.label;
					a.phaseId = next.id;
					a.progress = (i + 2) / LADDER.length;
				}
			}
		}, 1000);
		return () => clearInterval(id);
	});

	$effect(() =>
		onAction((id) => {
			if (id === 'crash') crash();
			else if (id === 'build') startBuild(0);
			else if (id === 'build2') startBuild(activities.length || unified.length ? 1 : 0);
			else if (id === 'toast')
				toasts.add({
					color: 'success',
					title: 'Changes saved',
					description: 'Env vars updated on api'
				});
			else if (id === 'toast-error')
				toasts.add({
					color: 'error',
					title: 'Replica restarted',
					description: 'web ran out of memory'
				});
			else if (id === 'succeed') finish('success');
			else if (id === 'fail-build') finish('error');
		})
	);
</script>

{#snippet sideColumn()}
	<div class="side">
		<NeedsAttention items={failing} {arriving} />
		<RecentBuilds builds={BUILD_FEED} />
	</div>
{/snippet}

{#snippet appCard(raw: Entity, pid: string)}
	{@const e = crashed.includes(`${pid}/${raw.name}`) ? { ...raw, status: CRASHING } : raw}
	{#if density === 'compact'}
		<EntityLine
			kind={e.kind}
			name={e.name}
			status={e.status}
			detail={e.url ?? e.detail}
			metrics={e.metrics}
			traffic={e.kind === 'deployment' ? traffic(e.name) : undefined}
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
			traffic={e.kind === 'deployment' ? traffic(e.name) : undefined}
			updatedAt={e.updatedAt}
			href="#"
			quick={e.kind === 'deployment'
				? [
						{ label: 'Visit', icon: ExternalLink, href: '#' },
						{ label: 'Redeploy', icon: RotateCw }
					]
				: []}
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
					<MenuItem>View logs</MenuItem>
					<MenuItem>Copy URL</MenuItem>
					<MenuItem danger>Delete</MenuItem>
				</Menu>
			{/snippet}
		</EntityCard>
	{/if}
{/snippet}

{#if exp.island === 'unified'}
	<Notifier takeOverToasts offsetLeft={278} shiftLeft={160} />
{:else if exp.island === 'on'}
	<LiveIsland
		{activities}
		offsetLeft={278}
		onDismiss={(id) => (activities = activities.filter((a) => a.id !== id))}
	/>
{/if}

<Page title="Your Apps" width="wide" aside={sideColumn}>
	{#snippet tools()}
		<SegmentedControl
			label="Project density"
			size="sm"
			bind:value={density}
			iconOnly
			options={[
				{ value: 'regular', label: 'Cards', icon: LayoutGrid },
				{ value: 'compact', label: 'List', icon: List }
			]}
			onchange={(v) => localStorage.setItem(DENSITY_KEY, v)}
		/>
	{/snippet}
	{#snippet actions()}
		{#if exp.search === 'spotlight'}
			<SpotlightSearch items={SEARCH_ITEMS} />
		{:else}
			<SearchField placeholder="Search apps" shortcut="/" />
		{/if}
		{#if exp.newButton === 'liquid'}
			<LiquidNewButton />
		{:else}
			<Button variant="primary" icon={Plus}>New</Button>
		{/if}
	{/snippet}

	<div class="projects projects--{density}">
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
				density={density as 'regular' | 'compact'}
				layout={density === 'compact' ? 'lines' : 'dense'}
			>
				{#each project.entities as e (e.name)}{@render appCard(e, project.id)}{/each}
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
		gap: 0.375rem;
	}
</style>
