<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import { ArrowLeft, Loader2, Database } from 'lucide-svelte';

	interface Project {
		id: string;
		name: string;
		slug: string;
	}

	let project = $state<Project | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');

	const projectSlug = $derived($page.params.projectSlug);
	const orgSlug = $derived($page.params.orgSlug);

	const generatedDbName = $derived(() => {
		const o = orgSlug.replace(/-/g, '_');
		const p = projectSlug.replace(/-/g, '_');
		const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'name';
		const full = `${o}_${p}_${n}`;
		return full.length > 61 ? full.substring(0, 61) : full;
	});

	async function fetchProject() {
		loading = true;
		try {
			const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
			if (!orgRes.ok) throw new Error('Organization not found');
			const org = await orgRes.json();

			const slugRes = await apiFetch(`/apiv1/projects/slug/${projectSlug}?orgId=${org.id}`);
			if (!slugRes.ok) throw new Error('Project not found');
			const projData = await slugRes.json();

			const projResponse = await apiFetch(`/apiv1/projects/${projData.id}`);
			if (!projResponse.ok) throw new Error('Failed to fetch project');
			project = await projResponse.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		} finally {
			loading = false;
		}
	}

	async function handleSubmit() {
		if (!project || !name.trim()) return;

		submitting = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/databases`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create database');
			}

			const database = await response.json();

			toasts.add({
				title: 'Database created',
				description: `${database.name} is ready`,
				color: 'success'
			});

			refreshTree();
			goto(`/${orgSlug}/databases/${database.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create database';
		} finally {
			submitting = false;
		}
	}

	onMount(fetchProject);
</script>

<div class="db-page">
	{#if loading}
		<div class="db-loading">
			<Loader2 class="h-6 w-6 animate-spin" />
			<span>Loading...</span>
		</div>
	{:else if project}
		<button
			onclick={() => goto(`/${orgSlug}/projects/${projectSlug}`)}
			class="db-back"
		>
			<ArrowLeft class="h-4 w-4" />
			{project.name}
		</button>

		<div class="db-header">
			<Database class="h-6 w-6" style="color: #22c55e" />
			<h1 class="db-title">New Database</h1>
		</div>
		<p class="db-subtitle">Create a PostgreSQL database on the shared cluster. A unique user and password will be generated automatically.</p>

		<!-- Template banner -->
		<a
			href="/{orgSlug}/projects/{projectSlug}/templates"
			class="db-template-banner"
		>
			<span class="db-template-cta">Looking for a complete app setup?</span>
			<span class="db-template-desc">Browse Templates to deploy pre-configured stacks with deployments and ingresses.</span>
		</a>

		{#if error}
			<div class="db-error">{error}</div>
		{/if}

		<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="db-form">
			<div class="db-field">
				<label for="db-name" class="db-label">Database Name</label>
				<input
					id="db-name"
					type="text"
					bind:value={name}
					placeholder="my-app-db"
					class="db-input"
					required
					disabled={submitting}
				/>
				<p class="db-hint">A slug-friendly name. The database will be created as <code>{generatedDbName()}</code></p>
			</div>

			<button type="submit" class="db-btn db-btn-primary" disabled={submitting || !name.trim()}>
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" />
					Creating...
				{:else}
					<Database class="h-4 w-4" />
					Create Database
				{/if}
			</button>
		</form>
	{/if}
</div>

<style>
	.db-page {
		max-width: 36rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.db-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.db-back {
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

	.db-back:hover {
		color: var(--center-channel-color);
	}

	.db-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.db-title {
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0;
	}

	.db-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0 0 1.5rem;
	}

	.db-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	.db-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.db-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.db-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.db-input {
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.875rem;
	}

	.db-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.db-input:disabled {
		opacity: 0.5;
	}

	.db-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.db-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
		width: fit-content;
	}

	.db-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.db-btn-primary {
		background-color: #22c55e;
		color: #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06);
	}

	.db-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-0.5px);
		box-shadow: 0 4px 6px rgb(0 0 0 / 0.1), 0 2px 4px rgb(0 0 0 / 0.06);
	}

	.db-template-banner {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.875rem 1.25rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color 0.15s;
		margin-bottom: 0.5rem;
	}

	.db-template-banner:hover {
		border-color: var(--sidebar-text-active-border);
	}

	.db-template-cta {
		font-size: 0.875rem;
		color: var(--sidebar-text-active-border);
		font-weight: 500;
	}

	.db-template-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}
</style>
