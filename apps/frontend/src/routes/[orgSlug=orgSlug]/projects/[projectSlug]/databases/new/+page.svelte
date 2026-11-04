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
	import { createQuery } from '@tanstack/svelte-query';
	import { Copy, Database, Link } from 'lucide-svelte';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';
	import { fromLocalInput, toLocalInput } from '$lib/components/database/recovery';
	import { formatWhen } from '$lib/components/database/BackupFormat';
	import { loadVersions, versionNote, versionOptions } from '$lib/components/database/versions';
	import type { DatabaseVersions } from '$lib/components/database/types';
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
		SegmentedControl,
		Slider,
		Stepper,
		Swap
	} from '$lib/components/ui';

	let project = $state<ProjectContext | null>(null);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');
	let storageSizeGi = $state(1);
	let pgMajor = $state<number | null>(null);
	let versions = $state<DatabaseVersions | null>(null);
	let versionsFailed = $state(false);
	const versionChoices = $derived(versionOptions(versions));
	const selectedVersion = $derived(versions?.versions.find((v) => v.major === pgMajor) ?? null);
	const versionHint = $derived.by(() => {
		if (versionsFailed) return "The version list didn't load. Orchard picks its default.";
		if (startFrom === 'url') return "Imports from a newer source use the source's version";
		if (!selectedVersion) return undefined;
		const note = versionNote(selectedVersion, versions?.defaultMajor);
		const minor = selectedVersion.minor ? `Starts on ${selectedVersion.minor}` : null;
		return [minor, note].filter(Boolean).join(' · ') || undefined;
	});

	async function fetchVersions() {
		const data = await loadVersions();
		versions = data;
		versionsFailed = !data;
		if (data && pgMajor === null) pgMajor = data.defaultMajor;
	}
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let restoreFromUrl = $state('');
	let selectedEnvId = $state($page.url.searchParams.get('env') ?? '');
	let replicas = $state(1);
	let maxReplicas = $state(5);

	type StartFrom = 'empty' | 'url' | 'copy';
	type CopyPoint = 'now' | 'latest' | 'time';
	const initialFrom = $page.url.searchParams.get('from') ?? '';
	let startFrom = $state<StartFrom>(initialFrom ? 'copy' : 'empty');
	let sourceId = $state(initialFrom);
	let sourceProjectId = $state('');
	let copyPoint = $state<CopyPoint>('now');
	let copyTime = $state('');
	let sourceWindow = $state<{ earliest: string | null; latest: string | null } | null>(null);

	const START_OPTIONS = [
		{ value: 'empty', label: 'Empty', icon: Database },
		{ value: 'url', label: 'Import from URL', icon: Link },
		{ value: 'copy', label: 'Copy of a database', icon: Copy }
	];

	type SourceDb = { id: string; name: string; mode?: string; status?: string; projectId: string };
	type CopyProject = { id: string; name: string; slug: string; icon?: string | null };

	const copyProjects = $derived.by<CopyProject[]>(() => {
		const list = (
			(overview.data?.projects ?? []) as (CopyProject & { canEdit?: boolean })[]
		).filter((p) => p.canEdit);
		if (project && !list.some((p) => p.id === project!.id)) {
			list.unshift({ id: project.id, name: project.name, slug: project.slug });
		}
		return list;
	});

	const allSources = $derived.by<SourceDb[]>(() => {
		const own = ((project?.databases as Omit<SourceDb, 'projectId'>[] | undefined) ?? []).map(
			(d) => ({ ...d, projectId: project!.id })
		);
		const others = (
			(overview.data?.databases ?? []) as (Omit<SourceDb, 'projectId'> & {
				project?: { id: string };
			})[]
		)
			.filter((d) => d.project?.id && d.project.id !== project?.id)
			.map((d) => ({
				id: d.id,
				name: d.name,
				mode: d.mode,
				status: d.status,
				projectId: d.project!.id
			}));
		const editable = new Set(copyProjects.map((p) => p.id));
		return [...own, ...others].filter(
			(d) => editable.has(d.projectId) && d.mode === 'cnpg' && d.status !== 'provisioning'
		);
	});

	const sourceProject = $derived(
		sourceProjectId || allSources.find((d) => d.id === initialFrom)?.projectId || project?.id || ''
	);
	const sources = $derived(allSources.filter((d) => d.projectId === sourceProject));
	const source = $derived(sources.find((d) => d.id === sourceId) ?? null);
	const crossProject = $derived(!!project && !!sourceProject && sourceProject !== project.id);
	const point = $derived<CopyPoint>(crossProject && copyPoint === 'now' ? 'latest' : copyPoint);

	function pickSourceProject(id: string) {
		sourceProjectId = id;
		sourceId = allSources.find((d) => d.projectId === id)?.id ?? '';
	}
	const copyTimeIso = $derived(fromLocalInput(copyTime));
	const copyTimeOk = $derived.by(() => {
		if (!copyTimeIso || !sourceWindow?.earliest) return false;
		const t = Date.parse(copyTimeIso);
		const hi = sourceWindow.latest ? Date.parse(sourceWindow.latest) + 60_000 : Date.now();
		return t >= Date.parse(sourceWindow.earliest) && t <= hi;
	});
	const copyReady = $derived(!!source && (point !== 'time' || copyTimeOk));

	let windowFor = '';
	$effect(() => {
		const id = sourceId;
		if (startFrom !== 'copy' || !id || windowFor === id) return;
		windowFor = id;
		void loadWindow(id);
	});

	$effect(() => {
		if (startFrom === 'copy' && !sourceId && sources.length) sourceId = sources[0].id;
	});

	async function loadWindow(id: string) {
		sourceWindow = null;
		try {
			const res = await apiFetch(`/apiv1/databases/${id}/recovery`);
			if (!res.ok || id !== sourceId) return;
			const data = await res.json();
			sourceWindow = { earliest: data.earliest ?? null, latest: data.latest ?? null };
			if (!copyTime) copyTime = toLocalInput(data.latest);
		} catch {
			return;
		}
	}

	const replicaHint = $derived(
		replicas === 1
			? 'A single instance. If its node goes down, the database goes down too.'
			: `One primary and ${replicas - 1} read ${replicas === 2 ? 'replica' : 'replicas'}, each with its own volume. Uses ${replicas}x the CPU and memory below.`
	);

	const projectSlug = $derived($page.params.projectSlug ?? '');
	const orgSlug = $derived($page.params.orgSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	const overview = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug && startFrom === 'copy'
	}));

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
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't load project";
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

	async function submitCopy() {
		if (!source || !copyReady) return;
		submitting = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/databases/${source.id}/fork`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					at: point === 'time' ? copyTimeIso : point,
					...(crossProject && project ? { projectId: project.id } : {}),
					...(selectedEnvId ? { environmentId: selectedEnvId } : {})
				})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't copy the database");
			}
			const op = await response.json();
			toasts.add({
				title: 'Copy started',
				description: `${name.trim()} is restoring from ${source.name}.`,
				color: 'success'
			});
			goto(op.targetDatabaseId ? `/${orgSlug}/databases/${op.targetDatabaseId}` : basePath);
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't copy the database";
		} finally {
			submitting = false;
		}
	}

	async function handleSubmit() {
		if (!project || !name.trim()) return;
		if (startFrom === 'copy') return submitCopy();

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
					restoreFromUrl: startFrom === 'url' ? restoreFromUrl.trim() || undefined : undefined,
					...(pgMajor ? { pgMajor } : {}),
					replicas,
					...(selectedEnvId ? { environmentId: selectedEnvId } : {})
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't create database");
			}

			const database = await response.json();

			toasts.add({
				title: 'Database created',
				description: `${database.name} is ready`,
				color: 'success'
			});

			goto(`/${orgSlug}/databases/${database.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't create database";
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

	onMount(() => {
		fetchLimits();
		fetchVersions();
	});
</script>

<Page
	title="New database"
	description="Orchard generates a unique user and password."
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
		{#if project || !error}
			<Button variant="ghost" href={basePath}>Cancel</Button>
			<Button
				variant="primary"
				type="submit"
				form="new-database"
				icon={Database}
				loading={submitting}
				disabled={submitting ||
					!project ||
					!name.trim() ||
					(startFrom === 'copy' && !copyReady) ||
					(startFrom === 'url' && !restoreFromUrl.trim())}
			>
				{startFrom === 'copy' ? 'Create copy' : 'Create database'}
			</Button>
		{/if}
	{/snippet}

	{#if error}
		<div class="nd-alert">
			<Alert tone="error">{error}</Alert>
		</div>
	{/if}

	{#if project || !error}
		<form
			id="new-database"
			class="nd-form"
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<SectionCard title="Start from">
				<div class="nd-stack">
					<RadioGroup
						label="Start from"
						variant="cards"
						columns={3}
						options={START_OPTIONS}
						bind:value={() => startFrom, (v) => (startFrom = v as StartFrom)}
						disabled={submitting}
					/>
					<Swap key={startFrom}>
						{#if startFrom === 'url'}
							<Field
								label="Connection URL"
								for="db-restore-url"
								hint="Orchard imports everything from this database. Orchard must be able to reach it."
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
						{:else if startFrom === 'copy'}
							<div class="nd-stack">
								{#if copyProjects.length > 1}
									<Field label="Project" for="db-source-project">
										<Dropdown
											id="db-source-project"
											size="lg"
											value={sourceProject}
											onchange={pickSourceProject}
											disabled={submitting}
											options={copyProjects.map((p) => ({ value: p.id, label: p.name }))}
										>
											{#snippet icon(id)}
												{@const p = copyProjects.find((x) => x.id === id)}
												<AppIcon name={p?.name ?? ''} icon={p?.icon} kind="project" size="xs" />
											{/snippet}
										</Dropdown>
									</Field>
								{/if}
								{#if sources.length === 0}
									<p class="nd-note">There is no database in this project to copy yet.</p>
								{:else}
									<Field label="Database" for="db-source">
										<Dropdown
											id="db-source"
											size="lg"
											bind:value={sourceId}
											disabled={submitting}
											options={sources.map((d) => ({ value: d.id, label: d.name }))}
										/>
									</Field>
									<Field
										label="From"
										hint={crossProject
											? 'A copy from another project starts from its backups'
											: undefined}
									>
										<SegmentedControl
											label="Copy from"
											options={[
												{ value: 'now', label: 'Now', disabled: crossProject },
												{ value: 'latest', label: 'Latest backup' },
												{ value: 'time', label: 'A time', disabled: !sourceWindow?.earliest }
											]}
											bind:value={() => point, (v) => (copyPoint = v as CopyPoint)}
											grow
										/>
									</Field>
									{#if point === 'time'}
										<Field
											for="db-copy-time"
											error={copyTime && !copyTimeOk
												? 'Pick a time inside the recovery window'
												: null}
											hint={sourceWindow?.earliest
												? `Any second from ${formatWhen(sourceWindow.earliest)} to now`
												: undefined}
										>
											<Input
												id="db-copy-time"
												type="datetime-local"
												step="1"
												min={toLocalInput(sourceWindow?.earliest)}
												max={toLocalInput(sourceWindow?.latest)}
												bind:value={copyTime}
												disabled={submitting}
											/>
										</Field>
									{/if}
								{/if}
							</div>
						{/if}
					</Swap>
				</div>
			</SectionCard>

			<SectionCard title="Database details">
				<div class="nd-stack">
					<Field label="Database name" for="db-name">
						{#snippet hint()}
							Lowercase letters, digits and hyphens. The database is created as <code
								>{generatedDbName()}</code
							>
						{/snippet}
						<Input
							id="db-name"
							bind:value={name}
							placeholder="my-app-db"
							required
							disabled={submitting}
						/>
					</Field>

					{#if startFrom !== 'copy'}
						<Field label="PostgreSQL version" for="db-pg-major" hint={versionHint}>
							<Dropdown
								id="db-pg-major"
								size="lg"
								bind:value={() => (pgMajor ? String(pgMajor) : ''), (v) => (pgMajor = Number(v))}
								disabled={submitting || versionsFailed}
								loading={!versions && !versionsFailed}
								placeholder={versionsFailed ? 'Default' : 'Loading versions'}
								options={versionChoices}
							/>
						</Field>

						<Field label="Storage size" for="db-size" hint="Defaults to 1 GiB.">
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
					{/if}
				</div>
			</SectionCard>

			{#if startFrom !== 'copy'}
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
							kind="database"
							disabled={submitting}
						/>
					</div>
				</SectionCard>
			{/if}
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
	.nd-note {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.nd-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
