<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree, fetchProjectContext, buildBasePath, type ProjectContext } from '$lib/stores';
	import { Loader2, Database } from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';

	let project = $state<ProjectContext | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');
	let storageSizeGi = $state(1);

	const projectSlug = $derived($page.params.projectSlug ?? '');
	const orgSlug = $derived($page.params.orgSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	const generatedDbName = $derived(() => {
		const o = orgSlug.replace(/-/g, '_');
		const p = projectSlug.replace(/-/g, '_');
		const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'name';
		const parts = wsSlug ? [o, wsSlug.replace(/-/g, '_'), p, n] : [o, p, n];
		const full = parts.join('_');
		return full.length > 61 ? full.substring(0, 61) : full;
	});

	async function fetchProject() {
		loading = true;
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
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
			const size = Math.max(1, Math.floor(Number(storageSizeGi) || 1));
			const response = await apiFetch(`/apiv1/projects/${project.id}/databases`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), storageSize: `${size}Gi` })
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

<div class="nd-page">
	{#if loading}
		<div class="skeleton" style="height: 0.8125rem; width: 6rem; margin-bottom: 1rem;"></div>
		<div class="skeleton" style="height: 1.5rem; width: 12rem; margin-bottom: 1.5rem;"></div>
		<div class="nd-card">
			<div class="skeleton" style="height: 1rem; width: 8rem; margin-bottom: 1rem;"></div>
			<div class="skeleton" style="height: 2.25rem; border-radius: 0.5rem;"></div>
		</div>
	{:else if project}
		<Breadcrumb crumbs={[
			{ label: 'Home', href: `/${orgSlug}` },
			{ label: project?.name || projectSlug || '', href: basePath },
			{ label: 'New Database' }
		]} />

		<div class="nd-header">
			<div class="nd-header-top">
				<h1 class="nd-title">New Database</h1>
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix="/databases/new"
				/>
			</div>
			<p class="nd-subtitle">Create a PostgreSQL database on the shared cluster. A unique user and password will be generated automatically.</p>
		</div>

		{#if error}
			<div class="nd-error">{error}</div>
		{/if}

		<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
			<div class="nd-card">
				<h2 class="nd-card-title">Database Details</h2>

				<div class="nd-field">
					<label for="db-name" class="nd-label">Database Name</label>
					<input
						id="db-name"
						type="text"
						bind:value={name}
						placeholder="my-app-db"
						class="nd-input"
						required
						disabled={submitting}
					/>
					<p class="nd-hint">A slug-friendly name. The database will be created as <code class="nd-mono">{generatedDbName()}</code></p>
				</div>

				<div class="nd-field">
					<label for="db-size" class="nd-label">Storage Size (GiB)</label>
					<input
						id="db-size"
						type="number"
						min="1"
						max="1024"
						step="1"
						bind:value={storageSizeGi}
						class="nd-input"
						disabled={submitting}
					/>
					<p class="nd-hint">Persistent volume size for this database. Defaults to 1 GiB.</p>
				</div>
			</div>

			<div class="nd-actions">
				<a href={basePath} class="nd-btn nd-btn-secondary">Cancel</a>
				<button type="submit" class="nd-btn nd-btn-primary" disabled={submitting || !name.trim()}>
					{#if submitting}
						<Loader2 class="h-4 w-4 animate-spin" />
						Creating...
					{:else}
						<Database class="h-4 w-4" />
						Create Database
					{/if}
				</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.nd-page {
		max-width: 36rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.nd-header {
		margin-bottom: 1.5rem;
	}

	.nd-header-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.nd-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.nd-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.nd-card {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		padding: 1.25rem;
		margin-bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.nd-card-title {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.nd-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.nd-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.nd-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.15s;
	}

	.nd-input::placeholder {
		color: var(--surface-muted);
	}

	.nd-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.nd-input:disabled {
		opacity: 0.5;
	}

	.nd-mono {
		font-family: var(--font-mono);
	}

	.nd-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.nd-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1rem;
	}

	.nd-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.nd-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		text-decoration: none;
		transition: opacity 0.15s;
		white-space: nowrap;
	}

	.nd-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.nd-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 1px 1px rgb(0 0 0 / 0.04);
	}

	.nd-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
	}

	.nd-btn-secondary {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.nd-btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}
</style>
