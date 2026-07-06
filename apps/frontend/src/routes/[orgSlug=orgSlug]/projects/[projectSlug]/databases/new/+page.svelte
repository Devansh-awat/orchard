<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		apiFetch,
		toasts,
		fetchProjectContext,
		buildBasePath,
		type ProjectContext
	} from '$lib/stores';
	import { Database } from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { Button, Field, Input } from '$lib/components/ui';

	let project = $state<ProjectContext | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');
	let storageSizeGi = $state(1);
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let restoreFromUrl = $state('');

	const projectSlug = $derived($page.params.projectSlug ?? '');
	const orgSlug = $derived($page.params.orgSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	const generatedDbName = $derived(() => {
		const o = orgSlug.replace(/-/g, '_');
		const p = projectSlug.replace(/-/g, '_');
		const n =
			name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_') || 'name';
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
				body: JSON.stringify({
					name: name.trim(),
					storageSize: `${size}Gi`,
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes,
					restoreFromUrl: restoreFromUrl.trim() || undefined
				})
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

			goto(`/${orgSlug}/databases/${database.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create database';
		} finally {
			submitting = false;
		}
	}

	$effect(() => {
		orgSlug;
		projectSlug;
		wsSlug;
		if (orgSlug && projectSlug) {
			fetchProject();
		}
	});
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
		<Breadcrumb
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{ label: project?.name || projectSlug || '', href: basePath },
				{ label: 'New database' }
			]}
		/>

		<div class="nd-header">
			<div class="nd-header-top">
				<h1 class="nd-title">New database</h1>
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix="/databases/new"
				/>
			</div>
			<p class="nd-subtitle">
				Create a PostgreSQL database on the shared cluster. Orchard generates a unique user and
				password for you.
			</p>
		</div>

		{#if error}
			<div class="nd-error">{error}</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<div class="nd-card">
				<h2 class="nd-card-title">Database details</h2>

				<Field label="Database name" for="db-name">
					<Input
						id="db-name"
						bind:value={name}
						placeholder="my-app-db"
						required
						disabled={submitting}
					/>
					<p class="nd-hint">
						A slug-friendly name. The database is created as <code class="font-mono"
							>{generatedDbName()}</code
						>
					</p>
				</Field>

				<Field
					label="Storage size (GiB)"
					for="db-size"
					hint="Persistent volume size for this database. Defaults to 1 GiB."
				>
					<input
						id="db-size"
						type="number"
						min="1"
						max="1024"
						step="1"
						bind:value={storageSizeGi}
						class="input"
						disabled={submitting}
					/>
				</Field>

				<Field
					label="Restore from existing database (optional)"
					for="db-restore-url"
					hint="If set, Orchard bootstraps the new database by importing data from this PostgreSQL connection URL. The source database must be reachable from the cluster."
				>
					<Input
						id="db-restore-url"
						bind:value={restoreFromUrl}
						placeholder="postgresql://user:password@host:5432/dbname"
						disabled={submitting}
						autocomplete="off"
						spellcheck="false"
					/>
				</Field>

				<Field label="Resources">
					<ResourcePicker
						bind:cpuMilli={resourceCpuMilli}
						bind:memoryBytes={resourceMemoryBytes}
						disabled={submitting}
					/>
				</Field>
			</div>

			<div class="nd-actions">
				<Button variant="ghost" href={basePath}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					loading={submitting}
					disabled={submitting || !name.trim()}
				>
					{#if !submitting}<Database class="h-4 w-4" />{/if}
					Create database
				</Button>
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
</style>
