<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import {
		ArrowLeft,
		Loader2,
		LayoutTemplate,
		Rocket,
		Database,
		Server,
		Globe
	} from 'lucide-svelte';

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

	const orgSlug = $derived($page.params.orgSlug);
	const wsSlug = $derived($page.params.wsSlug);
	const projectSlug = $derived($page.params.projectSlug);
	const templateId = $derived($page.params.templateId);

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
				return '#22c55e';
			case 'deployment':
				return '#3b82f6';
			case 'ingress':
				return '#f59e0b';
			default:
				return 'var(--surface-muted)';
		}
	}

	async function fetchData() {
		loading = true;
		try {
			// Fetch template
			const tplRes = await apiFetch(`/apiv1/templates/${templateId}`);
			if (!tplRes.ok) throw new Error('Failed to fetch template');
			template = await tplRes.json();

			// Initialize param values with defaults
			for (const param of template!.parameters) {
				if (param.default !== undefined) {
					paramValues[param.name] = param.default;
				} else if (param.type === 'boolean') {
					paramValues[param.name] = false;
				} else {
					paramValues[param.name] = '';
				}
			}

			// Fetch project
			const wsRes = await apiFetch(`/apiv1/workspaces/slug/${wsSlug}`);
			if (!wsRes.ok) throw new Error('Failed to fetch workspace');
			const workspace = await wsRes.json();
			const matched = workspace.projects?.find(
				(p: { slug: string }) => p.slug === projectSlug
			);
			if (!matched) throw new Error('Project not found');

			const projRes = await apiFetch(`/apiv1/projects/${matched.id}`);
			if (!projRes.ok) throw new Error('Failed to fetch project');
			project = await projRes.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load data';
		} finally {
			loading = false;
		}
	}

	async function deploy() {
		if (!project || !template) return;

		deploying = true;
		error = null;

		try {
			const response = await apiFetch(
				`/apiv1/projects/${project.id}/template-instances`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						templateId: template.id,
						parameters: paramValues
					})
				}
			);

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to deploy template');
			}

			const instance = await response.json();

			toasts.add({
				title: 'Template deployed',
				description: `${template.displayName} has been deployed successfully`,
				color: 'success'
			});

			refreshTree();
			goto(`/${orgSlug}/template-instances/${instance.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to deploy template';
		} finally {
			deploying = false;
		}
	}

	onMount(fetchData);
</script>

<div class="dp-page">
	{#if loading}
		<div class="dp-loading">
			<Loader2 class="h-6 w-6 animate-spin" />
			<span>Loading template...</span>
		</div>
	{:else if template}
		<button
			onclick={() =>
				goto(
					`/${orgSlug}/workspaces/${wsSlug}/projects/${projectSlug}/templates`
				)}
			class="dp-back"
		>
			<ArrowLeft class="h-4 w-4" />
			Templates
		</button>

		<div class="dp-header">
			<LayoutTemplate class="h-6 w-6" style="color: #ec4899" />
			<div>
				<h1 class="dp-title">Deploy {template.displayName}</h1>
				{#if template.description}
					<p class="dp-subtitle">{template.description}</p>
				{/if}
			</div>
		</div>

		<!-- What will be created -->
		<div class="dp-resources">
			<span class="dp-resources-label">This template will create:</span>
			<div class="dp-resources-list">
				{#each template.resources as resource}
					{@const Icon = getResourceIcon(resource.type)}
					<div class="dp-resource-chip" style="border-color: color-mix(in srgb, {getResourceColor(resource.type)} 40%, transparent)">
						<Icon
							class="h-3.5 w-3.5"
							style="color: {getResourceColor(resource.type)}"
						/>
						<span>{resource.name}</span>
						<span class="dp-resource-type">{resource.type}</span>
					</div>
				{/each}
			</div>
		</div>

		{#if error}
			<div class="dp-error">{error}</div>
		{/if}

		<!-- Parameter form -->
		<form
			onsubmit={(e) => {
				e.preventDefault();
				deploy();
			}}
			class="dp-form"
		>
			<h2 class="dp-section-title">Configuration</h2>

			{#each template.parameters as param}
				<div class="dp-field">
					<label for="param-{param.name}" class="dp-label">
						{param.displayName}
						{#if param.required}
							<span class="dp-required">*</span>
						{/if}
					</label>

					{#if param.type === 'string'}
						<input
							id="param-{param.name}"
							type="text"
							class="dp-input"
							placeholder={param.placeholder || ''}
							bind:value={paramValues[param.name]}
							required={param.required}
							disabled={deploying}
						/>
					{:else if param.type === 'number'}
						<input
							id="param-{param.name}"
							type="number"
							class="dp-input"
							min={param.validation?.min}
							max={param.validation?.max}
							bind:value={paramValues[param.name]}
							required={param.required}
							disabled={deploying}
						/>
					{:else if param.type === 'boolean'}
						<label class="dp-toggle">
							<input
								type="checkbox"
								bind:checked={paramValues[param.name]}
								disabled={deploying}
							/>
							<span class="dp-toggle-slider"></span>
							<span class="dp-toggle-label">
								{paramValues[param.name] ? 'Enabled' : 'Disabled'}
							</span>
						</label>
					{:else if param.type === 'select'}
						<select
							id="param-{param.name}"
							class="dp-input dp-select"
							bind:value={paramValues[param.name]}
							disabled={deploying}
						>
							{#each param.options || [] as option}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					{/if}

					{#if param.description}
						<p class="dp-hint">{param.description}</p>
					{/if}
				</div>
			{/each}

			<div class="dp-actions">
				<button type="submit" class="dp-btn dp-btn-primary" disabled={deploying}>
					{#if deploying}
						<Loader2 class="h-4 w-4 animate-spin" />
						Deploying...
					{:else}
						<Rocket class="h-4 w-4" />
						Deploy Template
					{/if}
				</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.dp-page {
		max-width: 40rem;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.dp-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.dp-back {
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

	.dp-back:hover {
		color: var(--center-channel-color);
	}

	.dp-header {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.dp-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.dp-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	/* Resources preview */
	.dp-resources {
		padding: 1rem 1.25rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
		margin-bottom: 1.5rem;
	}

	.dp-resources-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--surface-muted);
		display: block;
		margin-bottom: 0.625rem;
	}

	.dp-resources-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.dp-resource-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		font-size: 0.8125rem;
		color: var(--center-channel-color);
	}

	.dp-resource-type {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		padding: 0 0.25rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.dp-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	/* Form */
	.dp-form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.dp-section-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.dp-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.dp-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.dp-required {
		color: var(--error-text-color);
		margin-left: 0.125rem;
	}

	.dp-input {
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.875rem;
	}

	.dp-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.dp-input:disabled {
		opacity: 0.5;
	}

	.dp-select {
		cursor: pointer;
	}

	.dp-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	/* Toggle */
	.dp-toggle {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		cursor: pointer;
	}

	.dp-toggle input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.dp-toggle-slider {
		position: relative;
		width: 2.5rem;
		height: 1.375rem;
		background-color: var(--surface-border);
		border-radius: 9999px;
		transition: background-color 0.2s;
		flex-shrink: 0;
	}

	.dp-toggle-slider::after {
		content: '';
		position: absolute;
		top: 0.1875rem;
		left: 0.1875rem;
		width: 1rem;
		height: 1rem;
		background-color: #fff;
		border-radius: 50%;
		transition: transform 0.2s;
	}

	.dp-toggle input:checked + .dp-toggle-slider {
		background-color: #ec4899;
	}

	.dp-toggle input:checked + .dp-toggle-slider::after {
		transform: translateX(1.125rem);
	}

	.dp-toggle-label {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	/* Actions */
	.dp-actions {
		padding-top: 0.5rem;
	}

	.dp-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1.25rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.dp-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.dp-btn-primary {
		background-color: #ec4899;
		color: #fff;
	}

	.dp-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}
</style>
