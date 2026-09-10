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
		LayoutTemplate,
		Server,
		Search
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import { Badge, SectionHeader } from '$lib/components/ui';

	const orgSlug = $derived($page.params.orgSlug);
	const selectedOrgId = $derived($selectedOrganization?.id ?? '');

	const preselectedType = $derived($page.url.searchParams.get('type') as ResourceType | null);
	const preselectedProjectSlug = $derived($page.url.searchParams.get('projectSlug'));
	const autoCreateProject = $derived($page.url.searchParams.get('autoCreate') === '1');

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

	const resourceOptions: Array<{
		id: ResourceType;
		label: string;
		desc: string;
		icon: typeof Github;
		color: string;
		recommended?: boolean;
	}> = [
		{
			id: 'deployment-github',
			label: 'GitHub Repository',
			desc: 'Pick a repo. We detect the build, deploy it, and give it a URL.',
			icon: Github,
			color: '#6e5494',
			recommended: true
		},
		{
			id: 'deployment-image',
			label: 'Docker Image',
			desc: 'Deploy a container image',
			icon: Container,
			color: '#2496ed'
		},
		{
			id: 'database',
			label: 'Database',
			desc: 'Create a managed PostgreSQL database',
			icon: Database,
			color: '#f59e0b'
		}
	];

	const CATEGORY_LABELS: Record<string, string> = {
		cms: 'CMS',
		backend: 'Backend',
		frontend: 'Frontend',
		database: 'Database'
	};

	function formatCategory(category: string) {
		return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
	}

	function getIconForTemplate(icon?: string) {
		switch (icon) {
			case 'database':
				return Database;
			case 'globe':
				return Globe;
			case 'wordpress':
			case 'ghost':
			case 'nodejs':
				return Server;
			default:
				return LayoutTemplate;
		}
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

			if (preselectedType && resourceOptions.find((r) => r.id === preselectedType)) {
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

<div class="nr-page">
	<Breadcrumb crumbs={[{ label: 'Home', href: `/${orgSlug}` }, { label: 'New resource' }]} />

	<div class="nr-header">
		<h1 class="nr-title">Create a new resource</h1>
		<p class="nr-subtitle">What do you want to create?</p>
	</div>

	{#if loading}
		<div class="nr-type-grid">
			{#each Array(4) as _, i (i)}
				<div class="nr-type-card nr-type-skeleton">
					<div
						class="skeleton"
						style="width: 2.25rem; height: 2.25rem; border-radius: var(--radius-sm); flex-shrink: 0;"
					></div>
					<div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
						<div class="skeleton" style="height: 0.8125rem; width: 60%;"></div>
						<div class="skeleton" style="height: 0.625rem; width: 85%;"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="nr-type-grid">
			{#each resourceOptions as opt (opt.id)}
				{@const Icon = opt.icon}
				<button
					class="nr-type-card"
					class:nr-type-active={selectedResource === opt.id}
					disabled={navigating}
					onclick={() => selectResourceAndGo(opt.id)}
				>
					<div class="nr-type-icon">
						<Icon size={18} />
					</div>
					<div class="nr-type-text">
						<span class="nr-type-label">
							{opt.label}
							{#if opt.recommended}<Badge tone="info">Fastest</Badge>{/if}
						</span>
						<span class="nr-type-desc">{opt.desc}</span>
					</div>
					{#if selectedResource === opt.id && navigating}
						<Loader2
							size={16}
							class="animate-spin"
							style="color: var(--sidebar-text-active-border); flex-shrink: 0;"
						/>
					{/if}
				</button>
			{/each}
		</div>
		<!-- Templates -->
		{#if templates.length > 0}
			<div class="nr-tpl-section">
				<div class="nr-tpl-header">
					<SectionHeader title="Templates" count={templates.length} flush />
					{#if templates.length > 6}
						<div class="nr-tpl-search-wrap">
							<Search size={14} class="nr-tpl-search-icon" />
							<input
								type="search"
								placeholder="Search templates..."
								class="nr-tpl-search"
								bind:value={templateSearch}
							/>
						</div>
					{/if}
				</div>

				{#if filteredTemplates.length === 0}
					<p class="nr-tpl-empty">No templates match your search</p>
				{:else}
					<div class="nr-tpl-grid">
						{#each filteredTemplates as template (template.id)}
							{@const Icon = getIconForTemplate(template.icon)}
							<button
								class="nr-tpl-card"
								disabled={navigating}
								onclick={() => deployTemplate(template.id)}
							>
								<div class="nr-tpl-icon">
									<Icon size={16} />
								</div>
								<div class="nr-tpl-text">
									<span class="nr-tpl-name">{template.displayName}</span>
									{#if template.description}
										<span class="nr-tpl-desc">{template.description}</span>
									{/if}
								</div>
								{#if template.category}
									<span class="nr-tpl-badge">{formatCategory(template.category)}</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.nr-page {
		max-width: 40rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.nr-header {
		margin-bottom: 1.5rem;
	}

	.nr-title {
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.nr-subtitle {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--surface-muted);
		margin: 0.5rem 0 0;
	}

	/* Resource type grid */
	.nr-type-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: stretch;
	}
	@media (max-width: 720px) {
		.nr-type-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.nr-type-card {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		text-align: left;
		border: 1px solid var(--border-default);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		cursor: pointer;
		transition:
			border-color var(--dur-fast),
			box-shadow var(--dur-fast);
	}

	.nr-type-card:hover:not(:disabled) {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
	}

	.nr-type-card:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.nr-type-active {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
	}

	.nr-type-skeleton {
		pointer-events: none;
	}

	.nr-type-icon {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--fill-soft);
		color: var(--text-default);
	}

	.nr-type-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.nr-type-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nr-type-badge {
		display: inline-block;
		margin-left: 0.5rem;
		padding: 0.0625rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
		background: var(--accent-subtle);
	}

	.nr-type-desc {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
	}

	/* Templates section */
	.nr-tpl-section {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--surface-border);
	}

	.nr-tpl-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.nr-section-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
		margin: 0;
	}

	.nr-tpl-search-wrap {
		position: relative;
	}

	:global(.nr-tpl-search-icon) {
		position: absolute;
		left: 0.625rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--surface-muted);
		pointer-events: none;
	}

	.nr-tpl-search {
		padding: 0.3125rem 0.75rem 0.3125rem 1.75rem;
		border-radius: var(--radius-xs);
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		width: 12rem;
	}

	.nr-tpl-search::placeholder {
		color: var(--surface-muted);
	}

	.nr-tpl-search:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.nr-tpl-grid {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.nr-tpl-card {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			border-color var(--dur-fast);
		text-align: left;
		width: 100%;
	}

	.nr-tpl-card:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
		border-color: var(--surface-border);
	}

	.nr-tpl-card:disabled {
		opacity: 0.5;
		cursor: wait;
	}

	.nr-tpl-icon {
		background-color: var(--fill-soft);
		color: var(--text-default);
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.nr-tpl-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
	}

	.nr-tpl-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nr-tpl-desc {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		white-space: normal;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		overflow: hidden;
	}

	.nr-tpl-badge {
		flex-shrink: 0;
		align-self: center;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--fill-soft);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.nr-tpl-empty {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		text-align: center;
		padding: 1rem 0;
		margin: 0;
	}

	@media (max-width: 640px) {
		.nr-type-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
