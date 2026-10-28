<script lang="ts">
	import { onMount } from 'svelte';
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
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import {
		Alert,
		Breadcrumbs,
		Button,
		Field,
		Input,
		Page,
		SectionCard,
		Dropdown,
		Skeleton,
		Slider,
		Stepper
	} from '$lib/components/ui';

	let project = $state<ProjectContext | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');
	let storageSizeGi = $state(1);
	let pgMajor = $state(17);
	const PG_VERSIONS = [18, 17, 16, 15, 14, 13];
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let restoreFromUrl = $state('');
	let selectedEnvId = $state($page.url.searchParams.get('env') ?? '');
	let replicas = $state(1);
	let maxReplicas = $state(5);

	const replicaHint = $derived(
		replicas === 1
			? 'A single instance. If its node goes down the database goes with it.'
			: `One primary and ${replicas - 1} read ${replicas === 2 ? 'replica' : 'replicas'}, each a full pod with its own volume. Uses ${replicas}x the CPU and memory below.`
	);

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

	async function fetchLimits() {
		try {
			const response = await apiFetch('/apiv1/databases/limits');
			if (!response.ok) return;
			const limits = await response.json();
			if (Number.isFinite(limits?.maxReplicas)) {
				maxReplicas = Math.max(1, limits.maxReplicas);
				replicas = Math.min(replicas, maxReplicas);
			}
		} catch {
			return;
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
					restoreFromUrl: restoreFromUrl.trim() || undefined,
					pgMajor,
					replicas,
					...(selectedEnvId ? { environmentId: selectedEnvId } : {})
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

	onMount(fetchLimits);
</script>

<Page
	title="New database"
	description="Create a PostgreSQL database on the shared cluster. Orchard generates a unique user and password for you."
	width="narrow"
>
	{#snippet eyebrow()}
		<Breadcrumbs
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{ label: project?.name || projectSlug || '', href: basePath },
				{ label: 'New database' }
			]}
		/>
	{/snippet}

	{#snippet actions()}
		{#if project}
			<ProjectSwitcher
				currentProjectName={project.name || projectSlug}
				pathSuffix="/databases/new"
			/>
			<EnvironmentSwitcher projectId={project.id} bind:selectedEnvId />
		{/if}
	{/snippet}

	{#snippet footer()}
		{#if project}
			<Button variant="ghost" href={basePath}>Cancel</Button>
			<Button
				variant="primary"
				type="submit"
				form="new-database"
				icon={Database}
				loading={submitting}
				disabled={submitting || !name.trim()}
			>
				Create database
			</Button>
		{/if}
	{/snippet}

	{#if error}
		<div class="nd-alert">
			<Alert tone="error">{error}</Alert>
		</div>
	{/if}

	{#if loading}
		<SectionCard>
			<div class="nd-stack">
				<Skeleton width="8rem" height="1rem" />
				<Skeleton height="2rem" rounded="calc(var(--radius-control) * var(--corner-scale))" />
				<Skeleton width="12rem" height="0.75rem" />
				<Skeleton width="8rem" height="1rem" />
				<Skeleton height="2rem" rounded="calc(var(--radius-control) * var(--corner-scale))" />
			</div>
		</SectionCard>
	{:else if project}
		<form
			id="new-database"
			class="nd-form"
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<SectionCard title="Database details">
				<div class="nd-stack">
					<Field label="Database name" for="db-name">
						{#snippet hint()}
							A slug-friendly name. The database is created as <code>{generatedDbName()}</code>
						{/snippet}
						<Input
							id="db-name"
							bind:value={name}
							placeholder="my-app-db"
							required
							disabled={submitting}
						/>
					</Field>

					<Field
						label="PostgreSQL version"
						for="db-pg-major"
						hint="17 is the recommended default. Imports from a newer source automatically use the source's version."
					>
						<Dropdown
							id="db-pg-major"
							bind:value={() => String(pgMajor), (v) => (pgMajor = Number(v))}
							disabled={submitting}
							options={PG_VERSIONS.map((v) => ({ value: String(v), label: `PostgreSQL ${v}` }))}
						/>
					</Field>

					<Field
						label="Storage size"
						for="db-size"
						hint="Persistent volume size for this database. Defaults to 1 GiB."
					>
						<div>
							<Stepper
								id="db-size"
								label="Storage size in GiB"
								bind:value={storageSizeGi}
								min={1}
								max={1024}
								suffix="GiB"
								disabled={submitting}
							/>
						</div>
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
				</div>
			</SectionCard>

			<SectionCard title="Resources">
				<div class="nd-stack">
					<Field label="Instances" hint={replicaHint}>
						<Slider
							bind:value={replicas}
							min={1}
							max={maxReplicas}
							label="PostgreSQL instances"
							ticks
							showValue
							disabled={submitting}
						/>
					</Field>

					<ResourcePicker
						bind:cpuMilli={resourceCpuMilli}
						bind:memoryBytes={resourceMemoryBytes}
						disabled={submitting}
					/>
				</div>
			</SectionCard>
		</form>
	{/if}
</Page>

<style>
	.nd-alert {
		margin-bottom: 1rem;
	}
	.nd-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.nd-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
