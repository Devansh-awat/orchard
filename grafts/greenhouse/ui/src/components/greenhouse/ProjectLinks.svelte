<script lang="ts" module>
	import * as api from './api';
	import type { GhEnvironment, GhOrchardProject, GhProjectLink } from './types';

	export class ProjectLinkStore {
		links = $state.raw<GhProjectLink[]>([]);
		loaded = $state(false);
		projects = $state.raw<GhOrchardProject[]>([]);
		environments = $state.raw<GhEnvironment[]>([]);
		projectId = $state('');
		environmentId = $state('');
		busy = $state<string | null>(null);
		error = $state<string | null>(null);
		#projectsFor: string | null = null;

		available = $derived.by(() => {
			const linked = new Set(this.links.map((l) => l.projectId));
			return this.projects.filter((p) => !linked.has(p.id));
		});

		summary = $derived(
			!this.loaded
				? ''
				: this.links.length === 0
					? 'None'
					: this.links.map((l) => l.project.name).join(', ')
		);

		async load(sandboxId: string) {
			this.error = null;
			const res = await api.listLinks(sandboxId);
			this.links = res.ok ? (res.data.links ?? []) : [];
			this.loaded = true;
		}

		async loadProjects(
			org: string,
			who: { userId: string | null; orgRole: string | null; superAdmin: boolean }
		) {
			if (this.#projectsFor === org) return;
			this.#projectsFor = org;
			const res = await api.listEditableProjects(org, who);
			this.projects = res.ok ? res.data : [];
		}

		resetPick() {
			this.projectId = '';
			this.environmentId = '';
			this.environments = [];
			this.error = null;
		}

		async pickProject(id: string) {
			this.projectId = id;
			this.environmentId = '';
			this.environments = [];
			if (!id) return;
			const list = await api.listEnvironments(id);
			if (this.projectId !== id) return;
			this.environments = list;
			this.environmentId = (list.find((e) => e.isDefault) ?? list[0])?.id ?? '';
		}

		async attach(sandboxId: string): Promise<GhProjectLink | null> {
			if (!this.projectId || this.busy) return null;
			this.busy = 'attach';
			this.error = null;
			try {
				const link = await api.attachProject(sandboxId, {
					projectId: this.projectId,
					environmentId: this.environmentId || null
				});
				this.links = [...this.links.filter((l) => l.projectId !== link.projectId), link];
				this.resetPick();
				return link;
			} catch (e) {
				this.error = e instanceof Error ? e.message : 'Could not attach the project';
				return null;
			} finally {
				this.busy = null;
			}
		}

		async detach(sandboxId: string, link: GhProjectLink): Promise<string | null> {
			if (this.busy) return null;
			this.busy = link.projectId;
			try {
				await api.detachProject(sandboxId, link.projectId);
				this.links = this.links.filter((l) => l.projectId !== link.projectId);
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : 'Could not detach the project';
			} finally {
				this.busy = null;
			}
		}
	}
</script>

<script lang="ts">
	import { FolderGit2, X } from 'lucide-svelte';
	import { Field, Select } from '@orchard/graft-ui';
	import { toasts } from '../../host/stores';
	import { getGreenhouseApp } from './app.svelte';
	import FormError from './FormError.svelte';

	let { store, mode }: { store: ProjectLinkStore; mode: 'list' | 'attach' } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const owner = $derived(ws?.isOwner ?? false);

	async function detach(link: GhProjectLink) {
		if (!ws) return;
		const failed = await store.detach(ws.sandboxId, link);
		if (failed)
			toasts.add({ title: 'Could not detach the project', description: failed, color: 'error' });
	}
</script>

{#if mode === 'list'}
	{#if store.links.length > 0}
		<ul class="gh-group" aria-label="Attached projects">
			{#each store.links as link (link.id)}
				<li class="gh-group-row" class:gh-group-row--tight={owner} title={link.envFile}>
					<span class="glyph"><FolderGit2 size={16} strokeWidth={1.75} /></span>
					<span class="gh-group-name">{link.project.name}</span>
					<span class="env">{link.environment.name}</span>
					{#if owner}
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Detach {link.project.name}"
							title="Detach {link.project.name}"
							disabled={!!store.busy}
							onclick={() => detach(link)}
						>
							<X size={16} strokeWidth={1.75} />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if store.loaded}
		<p class="gh-sheet-note">No projects</p>
	{/if}
	{#if owner}
		<p class="gh-sheet-note">Guests can read these variables.</p>
	{/if}
{:else}
	<div class="picks">
		<Field label="Project" for="gh-link-project">
			<Select
				id="gh-link-project"
				value={store.projectId}
				data-autofocus
				disabled={store.available.length === 0}
				onchange={(e: Event) => store.pickProject((e.currentTarget as HTMLSelectElement).value)}
			>
				<option value="" disabled>
					{store.available.length === 0 ? 'No more projects you can edit' : 'Choose a project'}
				</option>
				{#each store.available as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Environment" for="gh-link-env">
			<Select
				id="gh-link-env"
				bind:value={store.environmentId}
				disabled={store.environments.length === 0}
			>
				{#if store.environments.length === 0}<option value="">Default</option>{/if}
				{#each store.environments as env (env.id)}
					<option value={env.id}>{env.name}</option>
				{/each}
			</Select>
		</Field>
	</div>
	{#if store.error}<FormError message={store.error} />{/if}
{/if}

<style>
	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		color: var(--gh-muted);
	}

	.env {
		flex: none;
		max-width: 40%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-muted);
	}

	.picks {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	@media (max-width: 720px) {
		.picks {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
