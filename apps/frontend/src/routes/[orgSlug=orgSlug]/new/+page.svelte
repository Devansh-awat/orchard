<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, user } from '$lib/stores';
	import {
		Loader2,
		Github,
		Container,
		Database,
		Globe,
		Ghost,
		Slack,
		Newspaper,
		LayoutTemplate,
		Search
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import { Badge, SectionHeader, Skeleton } from '$lib/components/ui';
	import { springHover, motionStagger } from '$lib/utils/motion.svelte';

	const orgSlug = $derived($page.params.orgSlug);
	const selectedOrgId = $derived($selectedOrganization?.id ?? '');

	const preselectedType = $derived($page.url.searchParams.get('type') as ResourceType | null);
	const preselectedProjectSlug = $derived($page.url.searchParams.get('projectSlug'));

	interface Template {
		id: string;
		name: string;
		displayName: string;
		description?: string;
		icon?: string;
		category?: string;
		tags: string[];
	}

	let projects = $state<Array<{ id: string; name: string; slug: string }>>([]);
	let templates = $state<Template[]>([]);
	let loading = $state(true);
	let navigating = $state(false);
	let templateSearch = $state('');

	type ResourceType = 'deployment-github' | 'deployment-image' | 'database';
	let selectedResource = $state<ResourceType | null>(null);

	const sources: Array<{
		id: ResourceType;
		label: string;
		desc: string;
		icon: typeof Github;
		hue: string;
		featured?: boolean;
	}> = [
		{
			id: 'deployment-github',
			label: 'GitHub repo',
			desc: 'Deploy straight from your code',
			icon: Github,
			hue: 'violet',
			featured: true
		},
		{
			id: 'deployment-image',
			label: 'Docker image',
			desc: 'Deploy a published container',
			icon: Container,
			hue: 'blue'
		},
		{
			id: 'database',
			label: 'Database',
			desc: 'Managed PostgreSQL',
			icon: Database,
			hue: 'amber'
		}
	];

	const CATEGORY_HUE: Record<string, string> = {
		cms: 'violet',
		bot: 'emerald',
		backend: 'blue',
		database: 'amber',
		frontend: 'pink'
	};

	const CATEGORY_LABELS: Record<string, string> = {
		cms: 'CMS',
		backend: 'Backend',
		frontend: 'Frontend',
		database: 'Database'
	};

	const TECH_ART: Record<string, string> = {
		nodejs: 'nodejs-original',
		node: 'nodejs-original',
		redis: 'redis-original',
		postgres: 'postgresql-original',
		postgresql: 'postgresql-original',
		nginx: 'nginx-original',
		python: 'python-original',
		go: 'go-original',
		rust: 'rust-original',
		mongodb: 'mongodb-original',
		mysql: 'mysql-original',
		grafana: 'grafana-original'
	};

	const BRAND_GLYPHS: Record<string, typeof Github> = {
		ghost: Ghost,
		slack: Slack,
		wordpress: Newspaper
	};

	const GENERIC_GLYPHS: Record<string, typeof Github> = {
		globe: Globe,
		database: Database
	};

	function formatCategory(category: string) {
		return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
	}

	function templateArt(t: Template): string | null {
		const icon = t.icon?.toLowerCase() ?? '';
		if (BRAND_GLYPHS[icon]) return null;
		for (const key of [icon, t.name, ...t.tags]) {
			const art = key && TECH_ART[key.toLowerCase()];
			if (art) return `/icons/tech/${art}.svg`;
		}
		return null;
	}

	function templateGlyph(t: Template) {
		const icon = t.icon?.toLowerCase() ?? '';
		return BRAND_GLYPHS[icon] ?? GENERIC_GLYPHS[icon] ?? LayoutTemplate;
	}

	const filteredTemplates = $derived.by(() => {
		const q = templateSearch.trim().toLowerCase();
		if (!q) return templates;
		return templates.filter(
			(t) =>
				t.displayName.toLowerCase().includes(q) ||
				t.description?.toLowerCase().includes(q) ||
				t.tags.some((tag) => tag.toLowerCase().includes(q))
		);
	});

	async function fetchProjects() {
		loading = true;
		try {
			const [projRes, tplRes] = await Promise.all([
				apiFetch(selectedOrgId ? `/apiv1/projects?orgId=${selectedOrgId}` : '/apiv1/projects'),
				apiFetch('/apiv1/templates')
			]);

			if (projRes.ok) {
				projects = (await projRes.json()).map((p: any) => ({
					id: p.id,
					name: p.name,
					slug: p.slug
				}));
			}
			if (tplRes.ok) {
				templates = await tplRes.json();
			}

			if (preselectedType && sources.find((r) => r.id === preselectedType)) {
				selectedResource = preselectedType;
			}
		} catch {
			/* */
		} finally {
			loading = false;
		}
	}

	async function createProject(name: string): Promise<string> {
		// Server auto-suffixes on slug collisions, so we just send the name.
		const projRes = await apiFetch('/apiv1/projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, organizationId: selectedOrgId })
		});
		if (!projRes.ok) {
			const d = await projRes.json().catch(() => ({}));
			throw new Error(d.message || 'Failed to create project');
		}
		const proj = await projRes.json();
		return proj.slug;
	}

	function defaultProjectName(): string {
		const u = $user;
		const display = u?.username?.trim() || u?.firstName?.trim() || u?.name?.trim() || 'My';
		return `${display}'s Project`;
	}

	async function resolveProjectSlug(): Promise<string> {
		if (preselectedProjectSlug && projects.some((p) => p.slug === preselectedProjectSlug)) {
			return preselectedProjectSlug;
		}
		if (projects.length === 0) {
			return createProject(defaultProjectName());
		}
		return projects[0].slug;
	}

	async function selectResourceAndGo(type: ResourceType) {
		selectedResource = type;
		navigating = true;

		try {
			// Deploying is the one flow that can name a project without creating it:
			// the form materializes it at submit, next to the deployment. Picking a
			// card is not a commitment, so an org with no projects yet gets the
			// name carried in the query rather than an empty project it never asked
			// for. Databases and templates still need one up front.
			const deploying = type === 'deployment-github' || type === 'deployment-image';
			if (deploying && projects.length === 0 && !preselectedProjectSlug) {
				const source = type === 'deployment-github' ? 'github' : 'image';
				goto(
					`/${orgSlug}/deployments/new?source=${source}&project=${encodeURIComponent(defaultProjectName())}`
				);
				return;
			}

			const projSlug = await resolveProjectSlug();
			const base = `/${orgSlug}/projects/${projSlug}`;
			switch (type) {
				case 'deployment-github':
					goto(`${base}/deployments/new?source=github`);
					break;
				case 'deployment-image':
					goto(`${base}/deployments/new?source=image`);
					break;
				case 'database':
					goto(`${base}/databases/new`);
					break;
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Something went wrong',
				color: 'error'
			});
			navigating = false;
		}
	}

	async function deployTemplate(templateId: string) {
		navigating = true;
		try {
			const projSlug = await resolveProjectSlug();
			goto(`/${orgSlug}/projects/${projSlug}/templates/deploy/${templateId}`);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Something went wrong',
				color: 'error'
			});
			navigating = false;
		}
	}

	onMount(fetchProjects);
</script>

<div class="nw-page">
	<Breadcrumb crumbs={[{ label: 'Home', href: `/${orgSlug}` }, { label: 'New' }]} />
	<h1 class="nw-pagetitle">Add something new</h1>

	<section class="nw-row" {@attach motionStagger({ index: 1, from: { y: 8 } })}>
		<SectionHeader title="Start from scratch" />
		<div class="nw-sources">
			{#each sources as source (source.id)}
				{@const Icon = source.icon}
				<button
					class="nw-card nw-source"
					class:nw-card--featured={source.featured}
					disabled={navigating}
					onclick={() => selectResourceAndGo(source.id)}
					{@attach springHover({ lift: -2 })}
				>
					<span class="nw-ic">
						{#if navigating && selectedResource === source.id}
							<Loader2 size={18} class="animate-spin" />
						{:else}
							<Icon size={18} />
						{/if}
					</span>
					<span class="nw-card-text">
						<span class="nw-card-name">
							{source.label}
							{#if source.featured}<Badge tone="info">Fastest</Badge>{/if}
						</span>
						<span class="nw-card-sub">{source.desc}</span>
					</span>
				</button>
			{/each}
		</div>
	</section>

	{#if loading}
		<section class="nw-row">
			<SectionHeader title="Templates" />
			<div class="nw-grid">
				{#each Array(5) as _, i (i)}
					<div class="nw-card nw-card--skel">
						<Skeleton width="2.25rem" height="2.25rem" rounded="var(--radius-sm)" />
						<Skeleton height="0.85rem" width="70%" />
						<Skeleton height="0.7rem" width="45%" />
					</div>
				{/each}
			</div>
		</section>
	{:else if templates.length > 0}
		<section class="nw-row" {@attach motionStagger({ index: 2, from: { y: 8 } })}>
			<SectionHeader title="Templates" count={templates.length}>
				{#snippet actions()}
					{#if templates.length > 6}
						<div class="nw-search">
							<Search size={14} />
							<input
								type="search"
								placeholder="Search templates"
								aria-label="Search templates"
								bind:value={templateSearch}
							/>
						</div>
					{/if}
				{/snippet}
			</SectionHeader>

			{#if filteredTemplates.length === 0}
				<p class="nw-empty">No templates match that search</p>
			{:else}
				<div class="nw-grid">
					{#each filteredTemplates as template (template.id)}
						{@const art = templateArt(template)}
						{@const Glyph = templateGlyph(template)}
						<button
							class="nw-card nw-tpl"
							style="--tile-hue: var(--hue-{CATEGORY_HUE[template.category ?? ''] ?? 'slate'});"
							disabled={navigating}
							onclick={() => deployTemplate(template.id)}
							{@attach springHover({ lift: -2 })}
						>
							<span class="nw-tpl-top">
								<span class="nw-ic nw-ic--tpl">
									{#if art}
										<img src={art} alt="" loading="lazy" />
									{:else}
										<Glyph size={18} />
									{/if}
								</span>
								{#if template.category}
									<span class="nw-tpl-cat">{formatCategory(template.category)}</span>
								{/if}
							</span>
							<span class="nw-card-text">
								<span class="nw-card-name">{template.displayName}</span>
								<span class="nw-card-sub">{template.tags.slice(0, 3).join(' · ')}</span>
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.nw-page {
		--gutter: 2.5rem;
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--space-8) var(--gutter) var(--space-12);
	}

	.nw-pagetitle {
		margin: var(--space-4) 0 var(--space-6);
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 650;
		letter-spacing: var(--track-title);
		color: var(--text-default);
	}

	.nw-row {
		margin-top: var(--space-8);
	}

	.nw-search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.3125rem var(--space-3);
		border-radius: var(--radius-sm);
		background-color: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-faint);
	}

	.nw-search input {
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		width: 9rem;
	}

	.nw-arrows {
		display: flex;
		gap: var(--space-1);
	}

	.nw-arrows button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		background-color: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			opacity var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.nw-arrows button:hover:not(:disabled) {
		background-color: var(--bg-hover);
	}

	.nw-arrows button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.nw-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		text-align: left;
		color: var(--text-default);
		cursor: pointer;
	}

	.nw-card::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.06),
			0 8px 22px rgb(0 0 0 / 0.09);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
		pointer-events: none;
	}

	.nw-card:hover:not(:disabled)::after {
		opacity: 1;
	}

	.nw-card:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.nw-card--featured {
		box-shadow:
			0 0 0 1.5px color-mix(in srgb, var(--accent) 40%, transparent),
			0 1px 2px rgb(0 0 0 / 0.04),
			0 3px 8px rgb(0 0 0 / 0.03);
	}

	.nw-card--skel {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-2);
		pointer-events: none;
	}

	.nw-ic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.375rem;
		height: 2.375rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		background-color: var(--fill-soft);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-muted);
	}

	.nw-ic--tpl {
		color: var(--tile-hue);
	}

	.nw-ic img {
		width: 1.375rem;
		height: 1.375rem;
		object-fit: contain;
	}

	.nw-card-text {
		display: block;
		flex: 1;
		min-width: 0;
	}

	.nw-card-name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nw-card-sub {
		display: block;
		margin-top: 0.125rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nw-sources {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-3);
	}

	.nw-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
		gap: var(--space-3);
	}

	.nw-tpl {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-3);
		min-height: 7.5rem;
		justify-content: space-between;
	}

	.nw-tpl-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.nw-tpl-cat {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-faint);
	}

	.nw-empty {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		margin: 0;
	}

	@media (max-width: 720px) {
		.nw-page {
			--gutter: 1.25rem;
		}
	}
</style>
