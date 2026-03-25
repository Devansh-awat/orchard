<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import { ArrowLeft, Loader2, Search, LayoutTemplate, Database, Globe, Server, Plus } from 'lucide-svelte';

	interface Template {
		id: string;
		name: string;
		displayName: string;
		description?: string;
		icon?: string;
		version: string;
		category?: string;
		tags: string[];
		isBuiltIn: boolean;
	}

	let templates = $state<Template[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let search = $state('');
	let selectedCategory = $state<string | null>(null);

	const orgSlug = $derived($page.params.orgSlug);
	const wsSlug = $derived($page.params.wsSlug);
	const projectSlug = $derived($page.params.projectSlug);

	const categories = $derived(() => {
		const cats = new Set<string>();
		for (const t of templates) {
			if (t.category) cats.add(t.category);
		}
		return Array.from(cats).sort();
	});

	const filteredTemplates = $derived.by(() => {
		let result = templates;
		if (selectedCategory) {
			result = result.filter((t) => t.category === selectedCategory);
		}
		const q = search.trim().toLowerCase();
		if (q) {
			result = result.filter(
				(t) =>
					t.displayName.toLowerCase().includes(q) ||
					t.description?.toLowerCase().includes(q) ||
					t.tags.some((tag) => tag.toLowerCase().includes(q))
			);
		}
		return result;
	});

	function getIconForTemplate(icon?: string) {
		switch (icon) {
			case 'wordpress':
			case 'ghost':
			case 'nodejs':
				return Server;
			case 'database':
				return Database;
			case 'globe':
				return Globe;
			default:
				return LayoutTemplate;
		}
	}

	function getCategoryColor(category?: string) {
		switch (category) {
			case 'cms':
				return '#8b5cf6';
			case 'backend':
				return '#3b82f6';
			case 'frontend':
				return '#22c55e';
			case 'database':
				return '#f59e0b';
			default:
				return 'var(--surface-muted)';
		}
	}

	async function fetchTemplates() {
		loading = true;
		try {
			const response = await apiFetch('/apiv1/templates');
			if (!response.ok) throw new Error('Failed to fetch templates');
			templates = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load templates';
		} finally {
			loading = false;
		}
	}

	onMount(fetchTemplates);
</script>

<div class="tpl-page">
	<button
		onclick={() => goto(`/${orgSlug}/workspaces/${wsSlug}/projects/${projectSlug}`)}
		class="tpl-back"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to Project
	</button>

	<div class="tpl-header">
		<div class="tpl-header-left">
			<LayoutTemplate class="h-6 w-6" style="color: #ec4899" />
			<h1 class="tpl-title">Templates</h1>
		</div>
		<a
			href="/{orgSlug}/workspaces/{wsSlug}/projects/{projectSlug}/templates/new"
			class="tpl-create-btn"
		>
			<Plus class="h-4 w-4" />
			Create Template
		</a>
	</div>
	<p class="tpl-subtitle">
		Deploy pre-configured application stacks with a single click. All resources are linked for
		easy management.
	</p>

	{#if error}
		<div class="tpl-error">{error}</div>
	{/if}

	{#if loading}
		<div class="tpl-loading">
			<Loader2 class="h-6 w-6 animate-spin" />
			<span>Loading templates...</span>
		</div>
	{:else}
		<!-- Filters -->
		<div class="tpl-filters">
			<div class="tpl-search-wrap">
				<Search class="h-4 w-4 tpl-search-icon" />
				<input
					type="search"
					placeholder="Search templates..."
					class="tpl-search"
					bind:value={search}
				/>
			</div>
			<div class="tpl-categories">
				<button
					class="tpl-cat-btn"
					class:tpl-cat-active={!selectedCategory}
					onclick={() => (selectedCategory = null)}
				>
					All
				</button>
				{#each categories() as cat}
					<button
						class="tpl-cat-btn"
						class:tpl-cat-active={selectedCategory === cat}
						onclick={() => (selectedCategory = selectedCategory === cat ? null : cat)}
					>
						{cat}
					</button>
				{/each}
			</div>
		</div>

		<!-- Grid -->
		{#if filteredTemplates.length === 0}
			<div class="tpl-empty">
				<LayoutTemplate class="h-10 w-10" style="color: var(--surface-muted)" />
				<p>No templates found</p>
			</div>
		{:else}
			<div class="tpl-grid">
				{#each filteredTemplates as template}
					{@const Icon = getIconForTemplate(template.icon)}
					<a
						href="/{orgSlug}/workspaces/{wsSlug}/projects/{projectSlug}/templates/deploy/{template.id}"
						class="tpl-card"
					>
						<div class="tpl-card-icon" style="background-color: color-mix(in srgb, {getCategoryColor(template.category)} 12%, transparent)">
							<Icon class="h-5 w-5" style="color: {getCategoryColor(template.category)}" />
						</div>
						<div class="tpl-card-body">
							<div class="tpl-card-top">
								<span class="tpl-card-name">{template.displayName}</span>
								{#if template.category}
									<span
										class="tpl-card-badge"
										style="background-color: color-mix(in srgb, {getCategoryColor(template.category)} 15%, transparent); color: {getCategoryColor(template.category)}"
									>
										{template.category}
									</span>
								{/if}
							</div>
							{#if template.description}
								<p class="tpl-card-desc">{template.description}</p>
							{/if}
							{#if template.tags.length}
								<div class="tpl-card-tags">
									{#each template.tags.slice(0, 4) as tag}
										<span class="tpl-card-tag">{tag}</span>
									{/each}
								</div>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.tpl-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.tpl-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1.5rem;
		transition: color 0.15s;
	}

	.tpl-back:hover {
		color: var(--center-channel-color);
	}

	.tpl-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.tpl-header-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.tpl-create-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		background-color: #ec4899;
		color: #fff;
		text-decoration: none;
		transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06);
	}

	.tpl-create-btn:hover {
		opacity: 0.9;
		transform: translateY(-0.5px);
		box-shadow: 0 4px 6px rgb(0 0 0 / 0.1), 0 2px 4px rgb(0 0 0 / 0.06);
	}

	.tpl-title {
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0;
	}

	.tpl-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0 0 1.5rem;
	}

	.tpl-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	.tpl-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	/* Filters */
	.tpl-filters {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.tpl-search-wrap {
		position: relative;
	}

	.tpl-search-wrap :global(.tpl-search-icon) {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--surface-muted);
		pointer-events: none;
	}

	.tpl-search {
		width: 100%;
		padding: 0.5rem 0.75rem 0.5rem 2.25rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.875rem;
	}

	.tpl-search:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.tpl-categories {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.tpl-cat-btn {
		padding: 0.25rem 0.75rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 500;
		border: 1px solid var(--surface-border);
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		text-transform: capitalize;
		transition: all 0.15s;
	}

	.tpl-cat-btn:hover {
		border-color: var(--center-channel-color);
		color: var(--center-channel-color);
	}

	.tpl-cat-active {
		background-color: var(--sidebar-text-active-border);
		border-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	.tpl-cat-active:hover {
		border-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	/* Grid */
	.tpl-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr));
		gap: 0.75rem;
	}

	.tpl-card {
		display: flex;
		gap: 1rem;
		padding: 1.25rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color 0.15s, box-shadow 0.15s;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03), 0 1px 2px rgb(0 0 0 / 0.02);
		cursor: pointer;
	}

	.tpl-card:hover {
		border-color: #ec4899;
		box-shadow: 0 0 0 1px color-mix(in srgb, #ec4899 25%, transparent);
	}

	.tpl-card-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: 0.75rem;
		flex-shrink: 0;
	}

	.tpl-card-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.tpl-card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.tpl-card-name {
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.tpl-card-badge {
		font-size: 0.6875rem;
		font-weight: 500;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		text-transform: capitalize;
		flex-shrink: 0;
	}

	.tpl-card-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.tpl-card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.tpl-card-tag {
		font-size: 0.6875rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--surface-muted);
	}

	/* Empty */
	.tpl-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--surface-muted);
		font-size: 0.875rem;
		border: 1px dashed var(--surface-border);
		border-radius: 1rem;
	}
</style>
