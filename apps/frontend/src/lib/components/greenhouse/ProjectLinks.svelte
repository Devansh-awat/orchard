<script lang="ts">
	import { FolderGit2, X } from 'lucide-svelte';
	import { Button, Select } from '$lib/components/ui';
	import { organizations, toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import FormError from './FormError.svelte';
	import type { GhEnvironment, GhOrchardProject, GhProjectLink } from './types';

	let { active }: { active: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const owner = $derived(ws?.isOwner ?? false);
	const orgId = $derived(app.machine?.organizationId ?? app.organizationId ?? null);

	let links = $state.raw<GhProjectLink[]>([]);
	let linksLoaded = $state(false);
	let projects = $state.raw<GhOrchardProject[]>([]);
	let environments = $state.raw<GhEnvironment[]>([]);
	let projectId = $state('');
	let environmentId = $state('');
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	const linked = $derived(new Set(links.map((l) => l.projectId)));
	const available = $derived(projects.filter((p) => !linked.has(p.id)));

	let loadedFor: string | null = null;
	$effect(() => {
		const id = active ? (ws?.sandboxId ?? null) : null;
		if (!id || id === loadedFor) return;
		loadedFor = id;
		error = null;
		void refresh(id);
		if (owner && orgId) void loadProjects(orgId);
	});

	async function refresh(id: string) {
		const res = await api.listLinks(id);
		links = res.ok ? (res.data.links ?? []) : [];
		linksLoaded = true;
	}

	async function loadProjects(org: string) {
		const role = $organizations.find((o) => o.id === org)?.myRole ?? null;
		const res = await api.listEditableProjects(org, {
			userId: app.self?.id ?? null,
			orgRole: role,
			superAdmin: app.superAdmin
		});
		projects = res.ok ? res.data : [];
	}

	async function pickProject(id: string) {
		projectId = id;
		environmentId = '';
		environments = [];
		if (!id) return;
		const list = await api.listEnvironments(id);
		if (projectId !== id) return;
		environments = list;
		environmentId = (list.find((e) => e.isDefault) ?? list[0])?.id ?? '';
	}

	async function attach() {
		if (!ws || !projectId || busy) return;
		busy = 'attach';
		error = null;
		try {
			const link = await api.attachProject(ws.sandboxId, {
				projectId,
				environmentId: environmentId || null
			});
			links = [...links.filter((l) => l.projectId !== link.projectId), link];
			toasts.add({
				title: `Attached ${link.project.name}`,
				description: `Variables land in ${link.envFile}`,
				color: 'success'
			});
			projectId = '';
			environmentId = '';
			environments = [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not attach the project';
		} finally {
			busy = null;
		}
	}

	async function detach(link: GhProjectLink) {
		if (!ws || busy) return;
		busy = link.projectId;
		try {
			await api.detachProject(ws.sandboxId, link.projectId);
			links = links.filter((l) => l.projectId !== link.projectId);
		} catch (e) {
			toasts.add({
				title: 'Could not detach the project',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}
</script>

<section class="links" aria-labelledby="gh-links-title">
	<p class="title" id="gh-links-title">Projects</p>
	{#if linksLoaded && links.length === 0}
		<p class="muted">
			No projects attached. Attaching one writes its variables and database address to a file on
			this machine.
		</p>
	{/if}
	{#each links as link (link.id)}
		<div class="row" data-align="link-row">
			<span class="ico"><FolderGit2 size={16} strokeWidth={1.75} /></span>
			<span class="who">
				<span class="name"
					>{link.project.name} <span class="env">{link.environment.name}</span></span
				>
				<span class="path gh-mono">{link.envFile}</span>
			</span>
			{#if owner}
				<button
					type="button"
					class="gh-ibtn"
					aria-label="Detach {link.project.name}"
					title="Detach {link.project.name}"
					disabled={!!busy}
					onclick={() => detach(link)}
				>
					<X size={16} strokeWidth={1.75} />
				</button>
			{/if}
		</div>
	{/each}

	{#if owner}
		<p class="disclosure">
			Every guest on this machine can read these variables from a terminal. The agent picks up new
			variables after it restarts.
		</p>
		<div class="add">
			<div class="pick">
				<Select
					value={projectId}
					aria-label="Project"
					disabled={available.length === 0}
					onchange={(e: Event) => pickProject((e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="" disabled>
						{available.length === 0 ? 'No more projects you can edit' : 'Project'}
					</option>
					{#each available as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</Select>
			</div>
			<div class="pick">
				<Select
					bind:value={environmentId}
					aria-label="Environment"
					disabled={environments.length === 0}
				>
					{#if environments.length === 0}<option value="">Environment</option>{/if}
					{#each environments as env (env.id)}
						<option value={env.id}>{env.name}</option>
					{/each}
				</Select>
			</div>
			<Button variant="secondary" disabled={!projectId || !!busy} onclick={attach}>
				{busy === 'attach' ? 'Attaching…' : 'Attach'}
			</Button>
		</div>
		{#if error}<FormError message={error} />{/if}
	{/if}
</section>

<style>
	.links {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.title,
	.muted,
	.disclosure {
		margin: 0;
	}

	.title {
		font-weight: 600;
		font-size: var(--text-footnote);
	}

	.muted {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.disclosure {
		margin-top: 0.25rem;
		color: var(--text-default);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		padding: 0.25rem calc(0.75rem - var(--gh-ibtn-inset)) 0.25rem 0.75rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--gh-line);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
		color: var(--text-muted);
	}

	.who {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.env {
		color: var(--text-muted);
	}

	.path {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}

	.add {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.pick {
		flex: 1;
		min-width: 0;
	}
</style>
