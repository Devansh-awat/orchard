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
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Dock, { type DockItem } from '$lib/components/patterns/Dock.svelte';
	import Shelf, { type ShelfItem } from '$lib/components/patterns/Shelf.svelte';
	import { IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import { templateCategory } from '$lib/utils/template-categories';
	import { prefetchGitHubRepos } from '$lib/queries/github';
	import { featureFlag } from '$lib/posthog';

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

	const orgSlug = $derived($page.params.orgSlug);
	const orgId = $derived($selectedOrganization?.id ?? '');
	const preselectedProject = $page.url.searchParams.get('projectSlug');
	const presetSource =
		$page.url.searchParams.get('source') ??
		($page.url.searchParams.get('type') === 'database' ? 'database' : null);

	let projects = $state<{ id: string; name: string; slug: string }[]>([]);
	let templates = $state<Template[]>([]);
	let loading = $state(true);
	let templateError = $state(false);
	let busy = $state<string | null>(null);
	let query = $state('');
	let projectSlug = $state('');
	let collapsedCategories = $state<string[]>([]);
	const currentProject = $derived(projects.find((p) => p.slug === projectSlug));

	const label = (t: Template) => templateCategory(t.category);
	const hq = featureFlag('hq');

	const nephthys = $derived($hq ? templates.find((t) => t.name === 'nephthys-plus') : undefined);

	const dock = $derived<DockItem[]>([
		{
			id: 'github',
			label: 'GitHub repo',
			hint: 'Deploy from your code',
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
			label: 'Postgres',
			hint: 'Managed, with backups',
			image: IMG_ICONS.postgres,
			href: sourceHref('database')
		},
		...(nephthys
			? [
					{
						id: `template:${nephthys.id}`,
						label: nephthys.displayName,
						hint: 'Support and ticket manager, for any program',
						image: nephthys.icon ?? undefined,
						href: templateHref(nephthys)
					}
				]
			: [])
	]);

	const MANAGED_PG = 'managed-postgres';

	const managedPostgres = $derived<ShelfItem>({
		id: MANAGED_PG,
		title: 'Postgres',
		subtitle: 'Managed by Orchard',
		description:
			'Postgres 13 to 18, managed by Orchard. Pick a version and get a connection string.',
		icon: IMG_ICONS.postgres,
		href: sourceHref('database')
	});

	const toItem = (t: Template): ShelfItem => ({
		id: t.id,
		title: t.displayName,
		subtitle: label(t),
		description: t.description,
		icon: t.icon,
		href: templateHref(t)
	});

	const shelves = $derived.by(() => {
		const groups = new Map<string, Template[]>();
		for (const t of templates) {
			const key = label(t);
			groups.set(key, [...(groups.get(key) ?? []), t]);
		}
		return [...groups.entries()]
			.sort((a, b) => {
				if (a[0] === 'Databases') return -1;
				if (b[0] === 'Databases') return 1;
				return a[0].localeCompare(b[0]);
			})
			.map(([title, list]) => ({
				title,
				items: list
					.toSorted(
						(a, b) => Number(b.name === 'nephthys-plus') - Number(a.name === 'nephthys-plus')
					)
					.map(toItem)
			}));
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
					(t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
					label(t).toLowerCase().includes(q) ||
					(t.category?.toLowerCase().includes(q) ?? false)
			)
			.map(toItem);
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
			throw new Error(d.message || "Couldn't create a project");
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
				title: "Couldn't start",
				description: e instanceof Error ? e.message : 'Something went wrong',
				color: 'error'
			});
			busy = null;
		}
	}

	function pick(item: ShelfItem) {
		if (item.id === MANAGED_PG) {
			openSource({ id: 'database', label: 'Postgres' });
			return;
		}
		openTemplate(item.id);
	}

	function toggleCategory(title: string) {
		collapsedCategories = collapsedCategories.includes(title)
			? collapsedCategories.filter((category) => category !== title)
			: [...collapsedCategories, title];
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
			} else if (!preset) templateError = true;
		} catch {
			templateError = true;
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
	{/snippet}

	<Stack gap="xl">
		<SearchField placeholder="Search templates" shortcut="/" bind:value={query} />
		<Stack gap="md">
			<SectionTitle title="Get started" size="md" />
			<Dock label="Get started" items={dock} columns={4} {busy} wrapHints onSelect={openSource} />
		</Stack>
		{#if query.trim()}
			{#if loading}
				<Skeleton height="12rem" rounded="1.25rem" />
			{:else if templateError}
				<EmptyState title="Couldn't load templates" description="Refresh the page to try again." />
			{:else if results.length}
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
			{#if loading}
				<Skeleton height="12rem" rounded="1.25rem" />
			{:else if templateError}
				<EmptyState title="Couldn't load templates" description="Refresh the page to try again." />
			{:else if !templates.length}
				<EmptyState title="No templates available" />
			{:else}
				<Shelf
					title="All templates"
					items={templates.map(toItem)}
					columns={4}
					plain
					autoScroll
					compact
					onSelect={pick}
				/>
				<SectionTitle title="Categories" size="md" />
				<div class="categories">
					{#each shelves as shelf (shelf.title)}
						{@const expanded = !collapsedCategories.includes(shelf.title)}
						<section class="category" aria-label={shelf.title}>
							<SectionTitle title={shelf.title} count={shelf.items.length} />
							<List inset={false} label={shelf.title}>
								{#each expanded ? shelf.items : shelf.items.slice(0, 3) as item (item.id)}
									<ListRow
										title={item.title}
										subtitle={item.description}
										href={item.href === '#' ? undefined : item.href}
										onclick={item.href === '#' ? () => pick(item) : undefined}
										flush
									>
										{#snippet leading()}
											<span class="category-icon">
												<AppIcon name={item.title} icon={item.icon} size="lg" />
											</span>
										{/snippet}
									</ListRow>
								{/each}
							</List>
							{#if shelf.items.length > 3}
								<Button
									variant="ghost"
									size="sm"
									aria-expanded={expanded}
									onclick={() => toggleCategory(shelf.title)}
								>
									{expanded ? 'Show less' : `Show all ${shelf.items.length}`}
								</Button>
							{/if}
						</section>
					{/each}
				</div>
			{/if}
		{/if}
	</Stack>
</Page>

<style>
	.into {
		color: var(--text-muted);
	}
	.into strong {
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.categories {
		columns: 3 16rem;
		column-gap: 2rem;
	}
	.category {
		break-inside: avoid;
		margin-bottom: 2rem;
	}
	.category-icon {
		zoom: 1.45;
	}
</style>
