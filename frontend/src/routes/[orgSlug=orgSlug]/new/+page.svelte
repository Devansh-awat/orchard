<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, refreshTree } from '$lib/stores';
	import {
		Loader2,
		Github, Container, Database, Globe, LayoutTemplate, Server, Search
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

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
	}> = [
		{ id: 'deployment-github', label: 'GitHub Repository', desc: 'Build and deploy from a GitHub repo', icon: Github, color: '#6e5494' },
		{ id: 'deployment-image', label: 'Docker Image', desc: 'Deploy a container image', icon: Container, color: '#2496ed' },
		{ id: 'database', label: 'Database', desc: 'Create a managed PostgreSQL database', icon: Database, color: '#f59e0b' },
	];

	function getCategoryColor(category?: string) {
		switch (category) {
			case 'cms': return '#8b5cf6';
			case 'backend': return '#3b82f6';
			case 'frontend': return '#22c55e';
			case 'database': return '#f59e0b';
			default: return 'var(--surface-muted)';
		}
	}

	function getIconForTemplate(icon?: string) {
		switch (icon) {
			case 'database': return Database;
			case 'globe': return Globe;
			case 'wordpress': case 'ghost': case 'nodejs': return Server;
			default: return LayoutTemplate;
		}
	}

	const filteredTemplates = $derived.by(() => {
		const q = templateSearch.trim().toLowerCase();
		if (!q) return templates;
		return templates.filter(t =>
			t.displayName.toLowerCase().includes(q) ||
			t.description?.toLowerCase().includes(q) ||
			t.tags.some(tag => tag.toLowerCase().includes(q))
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
				projects = (await projRes.json()).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug }));
			}
			if (tplRes.ok) {
				templates = await tplRes.json();
			}

			if (preselectedType && resourceOptions.find(r => r.id === preselectedType)) {
				selectedResource = preselectedType;
			}
		} catch { /* */ }
		finally { loading = false; }
	}

	function toSlug(n: string) { return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

	async function createProject(name: string): Promise<string> {
		const baseSlug = toSlug(name) || 'project';
		const existingSlugs = new Set(projects.map(p => p.slug));
		let slug = baseSlug;
		let i = 2;
		while (existingSlugs.has(slug)) { slug = `${baseSlug}-${i++}`; }
		const projRes = await apiFetch('/apiv1/projects', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, slug, organizationId: selectedOrgId })
		});
		if (!projRes.ok) {
			const d = await projRes.json().catch(() => ({}));
			throw new Error(d.message || 'Failed to create project');
		}
		const proj = await projRes.json();
		refreshTree();
		return proj.slug;
	}

	async function resolveProjectSlug(): Promise<string> {
		if (preselectedProjectSlug && projects.some(p => p.slug === preselectedProjectSlug)) {
			return preselectedProjectSlug;
		}
		if (projects.length === 0) {
			return createProject('Default');
		}
		return projects[0].slug;
	}

	async function selectResourceAndGo(type: ResourceType) {
		selectedResource = type;
		navigating = true;

		try {
			const projSlug = await resolveProjectSlug();
			const base = `/${orgSlug}/projects/${projSlug}`;
			switch (type) {
				case 'deployment-github': goto(`${base}/deployments/new?source=github`); break;
				case 'deployment-image': goto(`${base}/deployments/new?source=image`); break;
				case 'database': goto(`${base}/databases/new`); break;
			}
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Something went wrong', color: 'error' });
			navigating = false;
		}
	}

	async function deployTemplate(templateId: string) {
		navigating = true;
		try {
			const projSlug = await resolveProjectSlug();
			goto(`/${orgSlug}/projects/${projSlug}/templates/deploy/${templateId}`);
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Something went wrong', color: 'error' });
			navigating = false;
		}
	}

	onMount(fetchProjects);
</script>

<div class="nr-page">
	<Breadcrumb crumbs={[
		{ label: 'Home', href: `/${orgSlug}` },
		{ label: 'New Resource' }
	]} />

	<div class="nr-header">
		<h1 class="nr-title">Create a new resource</h1>
		<p class="nr-subtitle">What do you want to create?</p>
	</div>

	{#if loading}
		<div class="nr-type-grid">
			{#each Array(4) as _}
				<div class="nr-type-card nr-type-skeleton">
					<div class="skeleton" style="width: 2.25rem; height: 2.25rem; border-radius: 0.5rem; flex-shrink: 0;"></div>
					<div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
						<div class="skeleton" style="height: 0.8125rem; width: 60%;"></div>
						<div class="skeleton" style="height: 0.625rem; width: 85%;"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="nr-type-grid">
			{#each resourceOptions as opt}
				{@const Icon = opt.icon}
				<button
					class="nr-type-card"
					class:nr-type-active={selectedResource === opt.id}
					disabled={navigating}
					onclick={() => selectResourceAndGo(opt.id)}
				>
					<div class="nr-type-icon" style="background: color-mix(in srgb, {opt.color} 12%, transparent);">
						<Icon size={18} style="color: {opt.color}" />
					</div>
					<div class="nr-type-text">
						<span class="nr-type-label">{opt.label}</span>
						<span class="nr-type-desc">{opt.desc}</span>
					</div>
					{#if selectedResource === opt.id && navigating}
						<Loader2 size={16} class="animate-spin" style="color: var(--sidebar-text-active-border); flex-shrink: 0;" />
					{/if}
				</button>
			{/each}
		</div>
	<!-- Templates -->
	{#if templates.length > 0}
		<div class="nr-tpl-section">
			<div class="nr-tpl-header">
				<h2 class="nr-section-label">Templates</h2>
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
					{#each filteredTemplates as template}
						{@const Icon = getIconForTemplate(template.icon)}
						{@const color = getCategoryColor(template.category)}
						<button
							class="nr-tpl-card"
							disabled={navigating}
							onclick={() => deployTemplate(template.id)}
						>
							<div class="nr-tpl-icon" style="background: color-mix(in srgb, {color} 12%, transparent);">
								<Icon size={16} style="color: {color}" />
							</div>
							<div class="nr-tpl-text">
								<span class="nr-tpl-name">{template.displayName}</span>
								{#if template.description}
									<span class="nr-tpl-desc">{template.description}</span>
								{/if}
							</div>
							{#if template.category}
								<span class="nr-tpl-badge" style="background: color-mix(in srgb, {color} 12%, transparent); color: {color};">
									{template.category}
								</span>
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
		font-size: 1.375rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.nr-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.375rem 0 0;
	}

	/* Resource type grid */
	.nr-type-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.5rem;
	}

	.nr-type-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem 1.125rem;
		border-radius: 0.75rem;
		text-align: left;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		cursor: pointer;
		transition: border-color 0.15s, box-shadow 0.15s;
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
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.nr-type-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.nr-type-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nr-type-desc {
		font-size: 0.6875rem;
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
		font-size: 0.6875rem;
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
		padding: 0.3125rem 0.625rem 0.3125rem 1.75rem;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.75rem;
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
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		background: none;
		cursor: pointer;
		transition: background-color 0.12s, border-color 0.12s;
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
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
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
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.nr-tpl-desc {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nr-tpl-badge {
		font-size: 0.625rem;
		font-weight: 500;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		text-transform: capitalize;
		flex-shrink: 0;
	}

	.nr-tpl-empty {
		font-size: 0.8125rem;
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
