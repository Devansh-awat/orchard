<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { apiFetch, toasts, fetchProjectContext, buildBasePath } from '$lib/stores';
	import { Rocket, Database, Server, Globe, LayoutTemplate } from 'lucide-svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { Button, Input, Select } from '$lib/components/ui';

	interface ParameterDef {
		name: string;
		displayName: string;
		description?: string;
		type: 'string' | 'number' | 'boolean' | 'select';
		default?: any;
		required?: boolean;
		placeholder?: string;
		validation?: {
			pattern?: string;
			message?: string;
			min?: number;
			max?: number;
		};
		options?: { label: string; value: string }[];
	}

	interface ResourceSummary {
		name: string;
		type: 'deployment' | 'database' | 'ingress';
	}

	interface TemplateDetail {
		id: string;
		name: string;
		displayName: string;
		description?: string;
		icon?: string;
		version: string;
		category?: string;
		tags: string[];
		parameters: ParameterDef[];
		resources: ResourceSummary[];
	}

	let template = $state<TemplateDetail | null>(null);
	let project = $state<{ id: string; name: string } | null>(null);
	let loading = $state(true);
	let deploying = $state(false);
	let error = $state<string | null>(null);
	let paramValues = $state<Record<string, any>>({});
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);

	const orgSlug = $derived($page.params.orgSlug ?? '');
	const projectSlug = $derived($page.params.projectSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const templateId = $derived($page.params.templateId ?? '');
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN || 'a.lfdl.ink';

	function isDomainParam(param: ParameterDef): boolean {
		if (param.type !== 'string') return false;
		const tokens = param.name.split(/(?=[A-Z])|[_\s-]/).map((t) => t.toLowerCase());
		return tokens.some((t) => t === 'domain' || t === 'host' || t === 'hostname');
	}

	const appNameValue = $derived.by(() => {
		const nameParam = template?.parameters.find((p) => /name/i.test(p.name) && p.type === 'string');
		const v = nameParam ? paramValues[nameParam.name] : '';
		return typeof v === 'string' ? v.trim() : '';
	});

	const suggestedDomain = $derived(
		appNameValue
			? `${appNameValue
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, '-')
					.replace(/^-+|-+$/g, '')}.${APP_DOMAIN}`
			: null
	);

	function getResourceIcon(type: string) {
		switch (type) {
			case 'database':
				return Database;
			case 'deployment':
				return Server;
			case 'ingress':
				return Globe;
			default:
				return LayoutTemplate;
		}
	}

	function getResourceColor(type: string) {
		switch (type) {
			case 'database':
				return 'var(--online-indicator)';
			case 'deployment':
				return 'var(--link-color)';
			case 'ingress':
				return 'var(--away-indicator)';
			default:
				return 'var(--surface-muted)';
		}
	}

	async function fetchTemplate() {
		try {
			const tplRes = await apiFetch(`/apiv1/templates/${templateId}`);
			if (!tplRes.ok) throw new Error('Failed to fetch template');
			template = await tplRes.json();

			for (const param of template!.parameters) {
				if (param.default !== undefined) {
					paramValues[param.name] = param.default;
				} else if (param.type === 'boolean') {
					paramValues[param.name] = false;
				} else {
					paramValues[param.name] = '';
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load template';
		}
	}

	async function fetchProject() {
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		}
	}

	async function fetchData() {
		loading = true;
		await Promise.all([fetchTemplate(), fetchProject()]);
		loading = false;
	}

	async function deploy() {
		if (!project || !template) return;

		deploying = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/template-instances`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					templateId: template.id,
					parameters: paramValues,
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to deploy template');
			}

			const instance = await response.json();

			toasts.add({
				title: 'Template deployed',
				description: `${template.displayName} is deployed`,
				color: 'success'
			});

			goto(`/${orgSlug}/template-instances/${instance.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to deploy template';
		} finally {
			deploying = false;
		}
	}

	onMount(fetchData);

	let didInit = $state(false);
	$effect(() => {
		orgSlug;
		projectSlug;
		wsSlug;
		if (!didInit) {
			didInit = true;
			return;
		}
		if (orgSlug && projectSlug) {
			fetchProject();
		}
	});
</script>

<div class="td-page">
	{#if loading}
		<div class="skeleton" style="height: 1.5rem; width: 14rem; margin-bottom: 1.5rem;"></div>
		<div class="td-main-card">
			<div style="padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;">
				<div class="skeleton" style="height: 1rem; width: 10rem;"></div>
				<div class="skeleton" style="height: 2.25rem; border-radius: 0.5rem;"></div>
				<div class="skeleton" style="height: 2.25rem; border-radius: 0.5rem;"></div>
			</div>
		</div>
	{:else if template}
		<h1 class="td-page-title">Deploy template</h1>

		<!-- Main card -->
		<div class="td-main-card">
			<!-- Template info header -->
			<div class="td-info">
				<div class="td-info-icon">
					<LayoutTemplate size={20} />
				</div>
				<div class="td-info-text">
					<span class="td-info-name">{template.displayName}</span>
					{#if template.description}
						<span class="td-info-desc">{template.description}</span>
					{/if}
				</div>
				{#if template.category}
					<span
						class="td-info-badge"
						style="background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent); color: var(--sidebar-text-active-border);"
					>
						{template.category}
					</span>
				{/if}
			</div>

			<!-- Project selector -->
			<div class="td-project-row">
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix={`/templates/deploy/${templateId}`}
				/>
			</div>

			<!-- Resources preview -->
			<div class="td-resources">
				<span class="td-resources-label">This template creates</span>
				<div class="td-resources-list">
					{#each template.resources as resource (resource.name)}
						{@const Icon = getResourceIcon(resource.type)}
						{@const color = getResourceColor(resource.type)}
						<div class="td-resource-chip">
							<div class="td-resource-dot" style="background: {color};"></div>
							<span class="td-resource-name">{resource.name}</span>
							<span class="td-resource-type">{resource.type}</span>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<!-- Configuration card -->
		<div class="td-card">
			<h2 class="td-card-title">Configuration</h2>

			<form
				onsubmit={(e) => {
					e.preventDefault();
					deploy();
				}}
				class="td-form"
			>
				{#each template.parameters as param (param.name)}
					<div class="td-field">
						{#if param.type === 'boolean'}
							<label class="td-toggle-row">
								<div class="td-toggle-info">
									<span class="td-label">
										{param.displayName}
										{#if param.required}<span class="td-required">*</span>{/if}
									</span>
									{#if param.description}
										<span class="td-hint">{param.description}</span>
									{/if}
								</div>
								<div class="td-toggle-switch">
									<input
										type="checkbox"
										bind:checked={paramValues[param.name]}
										disabled={deploying}
									/>
									<span class="td-toggle-slider"></span>
								</div>
							</label>
						{:else}
							<label for="p-{param.name}" class="td-label">
								{param.displayName}
								{#if param.required}<span class="td-required">*</span>{/if}
							</label>

							{#if param.type === 'select'}
								<Select
									id="p-{param.name}"
									bind:value={paramValues[param.name]}
									disabled={deploying}
								>
									{#each param.options || [] as option (option.value)}
										<option value={option.value}>{option.label}</option>
									{/each}
								</Select>
							{:else if param.type === 'number'}
								<input
									id="p-{param.name}"
									type="number"
									class="input"
									min={param.validation?.min}
									max={param.validation?.max}
									bind:value={paramValues[param.name]}
									required={param.required}
									disabled={deploying}
								/>
							{:else}
								<Input
									id="p-{param.name}"
									placeholder={param.placeholder || ''}
									bind:value={paramValues[param.name]}
									required={param.required}
									disabled={deploying}
								/>
								{#if isDomainParam(param) && suggestedDomain && paramValues[param.name] !== suggestedDomain}
									<button
										type="button"
										class="td-suggest"
										onclick={() => (paramValues[param.name] = suggestedDomain)}
									>
										Use the free <strong>{suggestedDomain}</strong>
									</button>
								{/if}
							{/if}

							{#if param.description}
								<p class="td-hint">{param.description}</p>
							{/if}
						{/if}
					</div>
				{/each}

				<div class="td-field">
					<span class="td-label">Resources</span>
					<p class="td-hint" style="margin-top: 0;">
						Applies to every deployment and database created by this template.
					</p>
					<ResourcePicker
						bind:cpuMilli={resourceCpuMilli}
						bind:memoryBytes={resourceMemoryBytes}
						disabled={deploying}
					/>
				</div>

				{#if error}
					<div class="td-error">{error}</div>
				{/if}

				<div class="td-actions">
					<Button variant="ghost" href={basePath}>Cancel</Button>
					<Button variant="primary" type="submit" loading={deploying}>
						{#if !deploying}<Rocket class="h-4 w-4" />{/if}
						Deploy
					</Button>
				</div>
			</form>
		</div>
	{/if}
</div>

<style>
	.td-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.td-page-title {
		font-size: 1.375rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0 0 1.25rem;
		letter-spacing: -0.02em;
	}

	/* Main card */
	.td-main-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		margin-bottom: 1.25rem;
		overflow: hidden;
	}

	/* Template info header */
	.td-info {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.td-info-icon {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}

	.td-info-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.td-info-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.td-info-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		line-height: 1.4;
	}

	.td-info-badge {
		font-size: 0.625rem;
		font-weight: 600;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		text-transform: capitalize;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}

	/* Project row */
	.td-project-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.875rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--surface-border) 15%, transparent);
	}

	.td-suggest {
		align-self: flex-start;
		margin-top: 0.375rem;
		padding: 0.25rem 0.625rem;
		border: 1px dashed var(--border-default);
		border-radius: 9999px;
		background: none;
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color 120ms ease,
			border-color 120ms ease;
	}

	.td-suggest:hover {
		color: var(--text-default);
		border-color: var(--border-strong);
	}

	.td-suggest strong {
		font-weight: 650;
		font-family: var(--font-mono);
	}

	/* Resources preview */
	.td-resources {
		padding: 1rem 1.5rem;
	}

	.td-resources-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
		display: block;
		margin-bottom: 0.625rem;
	}

	.td-resources-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.td-resource-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: 0.375rem;
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
		font-size: 0.75rem;
		color: var(--center-channel-color);
	}

	.td-resource-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.td-resource-name {
		font-weight: 500;
	}

	.td-resource-type {
		color: var(--surface-muted);
	}

	/* Configuration card */
	.td-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		padding: 1.25rem 1.5rem;
		margin-bottom: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.td-card-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.td-form {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
	}

	/* Fields */
	.td-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.td-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.td-required {
		color: var(--error-text-color);
		margin-left: 0.125rem;
	}

	.td-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	/* Boolean toggle */
	.td-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		cursor: pointer;
		padding: 0.5rem 0;
	}

	.td-toggle-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.td-toggle-switch {
		position: relative;
		flex-shrink: 0;
	}

	.td-toggle-switch input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.td-toggle-slider {
		display: block;
		position: relative;
		width: 2.25rem;
		height: 1.25rem;
		background-color: var(--surface-border);
		border-radius: 9999px;
		transition: background-color 0.2s;
	}

	.td-toggle-slider::after {
		content: '';
		position: absolute;
		top: 0.1875rem;
		left: 0.1875rem;
		width: 0.875rem;
		height: 0.875rem;
		background-color: var(--button-color);
		border-radius: 50%;
		transition: transform 0.2s;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
	}

	.td-toggle-switch input:checked + .td-toggle-slider {
		background-color: var(--sidebar-text-active-border);
	}

	.td-toggle-switch input:checked + .td-toggle-slider::after {
		transform: translateX(1rem);
	}

	/* Error */
	.td-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
	}

	/* Actions */
	.td-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 0.25rem;
	}
</style>
