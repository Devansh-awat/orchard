<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Github, Container, LayoutTemplate, ChevronsUpDown } from 'lucide-svelte';
	import { apiFetch, selectedOrganization, toasts, user } from '$lib/stores';
	import Page from '$lib/components/ui/Page.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Stack from '$lib/components/ui/Stack.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';
	import FeatureHero, { type FeatureItem } from '$lib/components/patterns/FeatureHero.svelte';
	import Dock, { type DockItem } from '$lib/components/patterns/Dock.svelte';
	import Shelf, { type ShelfItem } from '$lib/components/patterns/Shelf.svelte';
	import { IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import { templateCategory } from '$lib/utils/template-categories';
	import { prefetchGitHubRepos } from '$lib/queries/github';

	interface Template {
		id: string;
		name: string;
		displayName: string;
		description?: string;
		icon?: string | null;
		category?: string;
		tags: string[];
	}

	type Source = 'github' | 'image' | 'database';

	const FEATURED = ['n8n', 'ghost', 'uptime-kuma', 'plausible', 'open-webui'];
	const POPULAR = 8;

	const orgSlug = $derived($page.params.orgSlug);
	const orgId = $derived($selectedOrganization?.id ?? '');
	const preselectedProject = $page.url.searchParams.get('projectSlug');
	const presetSource =
		$page.url.searchParams.get('source') ??
		($page.url.searchParams.get('type') === 'database' ? 'database' : null);

	let projects = $state<{ id: string; name: string; slug: string }[]>([]);
	let templates = $state<Template[]>([]);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let query = $state('');
	let projectSlug = $state('');
	const currentProject = $derived(projects.find((p) => p.slug === projectSlug));

	const label = (t: Template) => templateCategory(t.category);

	let spotlight = $state<Template[]>([]);

	function shuffle<T>(list: T[]) {
		const out = [...list];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}

	const featured = $derived<FeatureItem[]>(
		spotlight.map((t) => ({
			id: t.id,
			title: t.displayName,
			eyebrow: label(t),
			description: t.description,
			icon: t.icon,
			href: templateHref(t)
		}))
	);

	const redis = $derived(templates.find((t) => t.name === 'redis-oss'));

	const dock = $derived<DockItem[]>([
		{
			id: 'github',
			label: 'GitHub repo',
			hint: 'Deploy straight from your code',
			icon: Github,
			tone: 'ink',
			badge: 'Fastest',
			href: sourceHref('github')
		},
		{
			id: 'image',
			label: 'Docker image',
			hint: 'Run a published container',
			icon: Container,
			tone: 'blue',
			href: sourceHref('image')
		},
		{
			id: 'database',
			label: 'PostgreSQL',
			hint: 'Managed, with backups',
			image: IMG_ICONS.postgres,
			href: sourceHref('database')
		},
		...(redis
			? [
					{
						id: `template:${redis.id}`,
						label: 'Redis',
						hint: 'Cache, queues and sessions',
						image: IMG_ICONS.redis,
						href: templateHref(redis)
					}
				]
			: [])
	]);

	const MANAGED_PG = 'managed-postgres';

	const managedPostgres = $derived<ShelfItem>({
		id: MANAGED_PG,
		title: 'PostgreSQL',
		subtitle: 'Managed by Orchard',
		description: 'Postgres 13 to 18, run for you. Pick a version and get a connection string.',
		icon: IMG_ICONS.postgres,
		href: sourceHref('database')
	});

	const shelves = $derived.by(() => {
		const toItem = (t: Template): ShelfItem => ({
			id: t.id,
			title: t.displayName,
			subtitle: label(t),
			description: t.description,
			icon: t.icon,
			href: templateHref(t)
		});
		const popular = [
			...FEATURED.map((n) => templates.find((t) => t.name === n)).filter((t): t is Template => !!t),
			...templates.filter((t) => !FEATURED.includes(t.name))
		].slice(0, POPULAR);
		const groups = new Map<string, Template[]>();
		for (const t of templates) {
			const key = label(t);
			groups.set(key, [...(groups.get(key) ?? []), t]);
		}
		const sorted = [...groups.entries()].sort((a, b) => {
			if (a[0] === 'Databases') return -1;
			if (b[0] === 'Databases') return 1;
			return b[1].length - a[1].length;
		});
		const big = sorted.filter(([, list]) => list.length >= 3);
		const shown = new Set(popular.map((t) => t.id));
		const rest = sorted
			.filter(([, list]) => list.length < 3)
			.flatMap(([, list]) => list)
			.filter((t) => !shown.has(t.id));
		const withManaged = (title: string, items: ShelfItem[]) =>
			title === 'Databases' ? [managedPostgres, ...items] : items;
		const hasDatabases = big.some(([title]) => title === 'Databases');
		return [
			{ title: 'Popular', items: popular.map(toItem) },
			...(hasDatabases ? [] : [{ title: 'Databases', items: [managedPostgres] }]),
			...big.map(([title, list]) => ({ title, items: withManaged(title, list.map(toItem)) })),
			...(rest.length ? [{ title: 'More templates', items: rest.map(toItem) }] : [])
		];
	});

	const results = $derived.by<ShelfItem[]>(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const managed =
			q.length >= 2 &&
			['postgres', 'postgresql', 'database', 'sql', 'managed'].some(
				(k) => k.includes(q) || q.includes(k)
			)
				? [managedPostgres]
				: [];
		const found = templates
			.filter(
				(t) =>
					t.displayName.toLowerCase().includes(q) ||
					(t.description?.toLowerCase().includes(q) ?? false) ||
					t.tags.some((tag) => tag.toLowerCase().includes(q))
			)
			.map((t) => ({
				id: t.id,
				title: t.displayName,
				subtitle: label(t),
				description: t.description,
				icon: t.icon,
				href: templateHref(t)
			}));
		return [...managed, ...found];
	});

	function base() {
		return projectSlug ? `/${orgSlug}/projects/${projectSlug}` : null;
	}

	function templateHref(t: Template) {
		const b = base();
		return b ? `${b}/templates/deploy/${t.id}` : '#';
	}

	function sourceHref(source: Source) {
		const b = base();
		if (!b) {
			if (source === 'database') return '#';
			return `/${orgSlug}/deployments/new?source=${source}&project=${encodeURIComponent(defaultProjectName())}`;
		}
		return source === 'database' ? `${b}/databases/new` : `${b}/deployments/new?source=${source}`;
	}

	function defaultProjectName() {
		const u = $user;
		const name = u?.username?.trim() || u?.firstName?.trim() || u?.name?.trim() || 'My';
		return `${name}'s Project`;
	}

	async function ensureProject(): Promise<string> {
		if (projectSlug) return projectSlug;
		const res = await apiFetch('/apiv1/projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: defaultProjectName(), organizationId: orgId })
		});
		if (!res.ok) {
			const d = await res.json().catch(() => ({}));
			throw new Error(d.message || 'Could not create a project');
		}
		const p = await res.json();
		projects = [...projects, { id: p.id, name: p.name, slug: p.slug }];
		projectSlug = p.slug;
		return p.slug;
	}

	async function go(id: string, to: (slug: string) => string, replaceState = false) {
		busy = id;
		try {
			const slug = await ensureProject();
			await goto(to(slug), { replaceState });
		} catch (e) {
			toasts.add({
				title: 'Could not start',
				description: e instanceof Error ? e.message : 'Something went wrong',
				color: 'error'
			});
			busy = null;
		}
	}

	function pick(item: ShelfItem) {
		if (item.id === MANAGED_PG) {
			openSource({ id: 'database', label: 'PostgreSQL' });
			return;
		}
		openTemplate(item.id);
	}

	function openTemplate(id: string) {
		go(id, (slug) => `/${orgSlug}/projects/${slug}/templates/deploy/${id}`);
	}

	function openSource(item: DockItem, replaceState = false) {
		if (item.id.startsWith('template:')) return openTemplate(item.id.slice('template:'.length));
		const source = item.id as Source;
		if (!projectSlug && source !== 'database') {
			busy = item.id;
			goto(sourceHref(source), { replaceState });
			return;
		}
		go(
			item.id,
			(slug) =>
				source === 'database'
					? `/${orgSlug}/projects/${slug}/databases/new`
					: `/${orgSlug}/projects/${slug}/deployments/new?source=${source}`,
			replaceState
		);
	}

	onMount(async () => {
		void prefetchGitHubRepos();
		const preset =
			presetSource === 'github' || presetSource === 'image' || presetSource === 'database'
				? dock.find((d) => d.id === presetSource)
				: undefined;
		const tplEarly = preset ? null : apiFetch('/apiv1/templates').catch(() => null);
		try {
			const projRes = await apiFetch(orgId ? `/apiv1/projects?orgId=${orgId}` : '/apiv1/projects');
			if (projRes.ok) {
				projects = (await projRes.json()).map((p: { id: string; name: string; slug: string }) => ({
					id: p.id,
					name: p.name,
					slug: p.slug
				}));
			}
			projectSlug =
				preselectedProject && projects.some((p) => p.slug === preselectedProject)
					? preselectedProject
					: (projects[0]?.slug ?? '');
			const tplRes = await tplEarly;
			if (tplRes?.ok) {
				templates = await tplRes.json();
				const withIcons = templates.filter((t) => t.icon);
				spotlight = shuffle(withIcons.length >= 3 ? withIcons : templates).slice(0, 5);
			}
		} finally {
			loading = false;
		}
		if (preset) openSource(preset, true);
	});
</script>

<svelte:head><title>New</title></svelte:head>

<Page title="New" width="wide">
	{#snippet actions()}
		{#if projects.length > 1}
			<Menu placement="bottom-end" size="lg">
				{#snippet trigger(attrs)}
					<Button {...attrs} variant="secondary" iconRight={ChevronsUpDown}>
						<span class="into">Into <strong>{currentProject?.name ?? 'a project'}</strong></span>
					</Button>
				{/snippet}
				<MenuLabel>Deploy into</MenuLabel>
				{#each projects as p (p.id)}
					<MenuItem checked={p.slug === projectSlug} onclick={() => (projectSlug = p.slug)}>
						{#snippet leading()}<AppIcon name={p.name} kind="project" size="sm" />{/snippet}
						{p.name}
					</MenuItem>
				{/each}
			</Menu>
		{/if}
		<SearchField placeholder="Search templates" shortcut="/" bind:value={query} />
	{/snippet}

	{#if query.trim()}
		{#if results.length}
			<Shelf
				title="Templates matching “{query.trim()}”"
				items={results}
				columns={4}
				plain
				onSelect={pick}
			/>
		{:else}
			<EmptyState
				title="No templates match “{query.trim()}”"
				description="Try a name like Ghost or Postgres, or start from a repo or an image."
			>
				{#snippet icon()}<LayoutTemplate size={22} />{/snippet}
			</EmptyState>
		{/if}
	{:else}
		<Stack gap="xl">
			{#if loading}
				<Skeleton height="18rem" rounded="1.875rem" />
			{:else if featured.length}
				<FeatureHero items={featured} columns={4} onSelect={(item) => openTemplate(item.id)} />
			{/if}

			<Stack gap="md">
				<SectionTitle title="Start from scratch" size="md" />
				<Dock label="Start from scratch" items={dock} columns={4} {busy} onSelect={openSource} />
			</Stack>

			{#if loading}
				<Skeleton height="12rem" rounded="1.25rem" />
			{:else}
				{#each shelves as shelf (shelf.title)}
					<Shelf title={shelf.title} items={shelf.items} columns={4} plain onSelect={pick} />
				{/each}
			{/if}
		</Stack>
	{/if}
</Page>

<style>
	.into {
		color: var(--text-muted);
	}
	.into strong {
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
</style>
