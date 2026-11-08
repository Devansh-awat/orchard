<script lang="ts">
	import { Plus, Trash2 } from 'lucide-svelte';
	import {
		Alert,
		Button,
		FormActions,
		Input,
		SectionCard,
		Select,
		Skeleton
	} from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';

	interface ProjectChoice {
		id: string;
		name: string;
		group?: string;
	}

	interface Row {
		key: string;
		value: string;
		projectId: string;
		role: 'viewer' | 'member' | 'admin';
	}

	let {
		baseUrl,
		providerName,
		projects,
		readonly = false
	}: {
		baseUrl: string;
		providerName: string;
		projects: ProjectChoice[];
		readonly?: boolean;
	} = $props();

	const ROLES = [
		{ value: 'viewer', label: 'Viewer' },
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' }
	] as const;

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let rows = $state<Row[]>([]);
	let saved = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let counter = 0;

	const payload = (list: Row[]) =>
		list
			.filter((r) => r.value.trim() && r.projectId)
			.map((r) => ({ value: r.value.trim(), projectId: r.projectId, role: r.role }));
	const dirty = $derived(JSON.stringify(payload(rows)) !== saved);
	const incomplete = $derived(rows.some((r) => !r.value.trim() || !r.projectId));
	const duplicate = $derived.by(() => {
		const seen = new Set<string>();
		for (const r of rows) {
			const key = `${r.projectId}\u0000${r.value.trim()}`;
			if (r.value.trim() && seen.has(key)) return r.value.trim();
			seen.add(key);
		}
		return null;
	});

	$effect(() => {
		void load(baseUrl);
	});

	function key() {
		counter += 1;
		return `row-${counter}`;
	}

	async function load(url: string) {
		loading = true;
		loadError = null;
		try {
			const res = await apiFetch(`${url}/project-rules`);
			if (!res.ok) throw new Error("Couldn't load the project rules");
			const data = (await res.json()) as Array<{
				value: string;
				projectId: string;
				role: { name: Row['role'] };
			}>;
			rows = data.map((r) => ({
				key: key(),
				value: r.value,
				projectId: r.projectId,
				role: r.role.name
			}));
			saved = JSON.stringify(payload(rows));
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the project rules";
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (saving || incomplete || duplicate) return;
		saving = true;
		saveError = null;
		try {
			const res = await apiFetch(`${baseUrl}/project-rules`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rules: payload(rows) })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || "Couldn't save the project rules");
			saved = JSON.stringify(payload(rows));
			toasts.add({ title: 'Project rules saved', color: 'success' });
		} catch (e) {
			saveError = e instanceof Error ? e.message : "Couldn't save the project rules";
		} finally {
			saving = false;
		}
	}

	function addRow() {
		rows = [...rows, { key: key(), value: '', projectId: projects[0]?.id ?? '', role: 'member' }];
	}
</script>

<SectionCard
	title="Project access"
	description="Give people in a {providerName} group a role on a project. It only applies to people who are already in the project's organization, and never changes access someone was given by hand."
>
	{#snippet actions()}
		{#if !readonly}
			<Button
				size="sm"
				shape="capsule"
				icon={Plus}
				disabled={loading || projects.length === 0}
				onclick={addRow}
			>
				Add rule
			</Button>
		{/if}
	{/snippet}

	{#if loading}
		<Skeleton height="4rem" rounded="var(--radius-card)" />
	{:else if loadError}
		<Alert tone="error">{loadError}</Alert>
	{:else}
		{#if rows.length}
			<ul class="rules" aria-label="Project rules">
				{#each rows as row (row.key)}
					<li class="rule">
						<Input
							bind:value={row.value}
							placeholder="Group name"
							aria-label="Group name"
							autocomplete="off"
							spellcheck={false}
							disabled={readonly}
						/>
						<Select bind:value={row.projectId} aria-label="Project" disabled={readonly}>
							<option value="" disabled>Choose a project</option>
							{#each projects as project (project.id)}
								<option value={project.id}
									>{project.group ? `${project.group} / ${project.name}` : project.name}</option
								>
							{/each}
						</Select>
						<Select bind:value={row.role} aria-label="Project role" disabled={readonly}>
							{#each ROLES as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</Select>
						{#if !readonly}
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove rule for {row.value || 'this group'}"
								onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="quiet">
				{projects.length
					? 'No project rules. Project access stays whatever admins set by hand.'
					: 'There are no projects to map yet.'}
			</p>
		{/if}
		{#if duplicate}
			<div class="notice">
				<Alert tone="error">“{duplicate}” appears twice for the same project.</Alert>
			</div>
		{/if}
		{#if saveError}
			<div class="notice"><Alert tone="error">{saveError}</Alert></div>
		{/if}
		{#if !readonly}
			<div class="save">
				<FormActions>
					<Button variant="ghost" disabled={!dirty || saving} onclick={() => load(baseUrl)}
						>Discard</Button
					>
					<Button
						variant="primary"
						loading={saving}
						disabled={!dirty || incomplete || !!duplicate}
						onclick={save}>Save rules</Button
					>
				</FormActions>
			</div>
		{/if}
	{/if}
</SectionCard>

<style>
	.rules {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rule {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 8rem auto;
		align-items: center;
		gap: var(--space-2);
	}
	.quiet {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.notice,
	.save {
		margin-top: var(--space-4);
	}
</style>
