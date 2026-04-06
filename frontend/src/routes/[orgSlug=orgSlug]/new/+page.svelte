<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, refreshTree } from '$lib/stores';
	import {
		ArrowLeft, Loader2, ChevronRight, Check,
		Github, Container, Database, Globe, Rocket, Plus, Users
	} from 'lucide-svelte';

	const orgSlug = $derived($page.params.orgSlug);
	const selectedOrgId = $derived($selectedOrganization?.id ?? '');

	// Existing projects
	let projects = $state<Array<{ projId: string; projName: string; projSlug: string }>>([]);
	let loading = $state(true);
	let creating = $state(false);

	// Mode
	let mode = $state<'existing' | 'new'>('existing');
	let selectedProjectIdx = $state(0);
	let newProjectName = $state('');

	// Resource type
	type ResourceType = 'deployment-github' | 'deployment-image' | 'database' | 'ingress';
	let selectedResource = $state<ResourceType>('deployment-github');

	const resourceOptions = [
		{ id: 'deployment-github' as ResourceType, label: 'GitHub Repository', desc: 'Build and deploy from a GitHub repo', icon: Github, color: '#6e5494' },
		{ id: 'deployment-image' as ResourceType, label: 'Docker Image', desc: 'Deploy a container image', icon: Container, color: '#2496ed' },
		{ id: 'database' as ResourceType, label: 'Database', desc: 'Create a managed database', icon: Database, color: '#f59e0b' },
		{ id: 'ingress' as ResourceType, label: 'Ingress', desc: 'Expose a service publicly', icon: Globe, color: '#22c55e' },
	];

	function toSlug(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

	async function fetchProjects() {
		loading = true;
		try {
			const url = selectedOrgId ? `/apiv1/projects?orgId=${selectedOrgId}` : '/apiv1/projects';
			const res = await apiFetch(url);
			if (!res.ok) throw new Error();
			const allProjects = await res.json();

			projects = allProjects.map((p: any) => ({ projId: p.id, projName: p.name, projSlug: p.slug }));

			if (projects.length === 0) { mode = 'new'; newProjectName = 'My Project'; }
		} catch { /* */ }
		finally { loading = false; }
	}

	let canProceed = $derived(mode === 'new' ? newProjectName.trim().length > 0 : projects.length > 0);

	async function proceed() {
		creating = true;
		try {
			let projSlug: string;

			if (mode === 'new') {
				const name = newProjectName.trim();
				const slug = toSlug(name);

				const projRes = await apiFetch('/apiv1/projects', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name, slug, organizationId: selectedOrgId })
				});
				if (!projRes.ok) { const d = await projRes.json().catch(() => ({})); throw new Error(d.message || 'Failed to create project'); }
				const proj = await projRes.json();
				projSlug = proj.slug;
				refreshTree();
			} else {
				const p = projects[selectedProjectIdx];
				if (!p) throw new Error('Select a project');
				projSlug = p.projSlug;
			}

			const base = `/${orgSlug}/projects/${projSlug}`;
			switch (selectedResource) {
				case 'deployment-github': goto(`${base}/deployments/new?source=github`); break;
				case 'deployment-image': goto(`${base}/deployments/new?source=image`); break;
				case 'database': goto(`${base}/databases/new`); break;
				case 'ingress': goto(`${base}/ingresses/new`); break;
			}
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Something went wrong', color: 'error' });
		} finally { creating = false; }
	}

	onMount(fetchProjects);
</script>

<div class="pg">
	<button onclick={() => goto(`/${orgSlug}`)} class="back"><ArrowLeft size={16} /> Home</button>

	<div class="head">
		<div class="head-icon"><Rocket size={24} /></div>
		<div>
			<h1 class="head-title">New Deployment</h1>
			<p class="head-sub">Choose what to deploy and where to put it.</p>
		</div>
	</div>

	{#if loading}
		<div class="card"><div class="card-loading"><Loader2 size={18} class="spin" /> Loading...</div></div>
	{:else}
		<!-- What -->
		<section class="sec">
			<h2 class="sec-title">What do you want to deploy?</h2>
			<div class="res-grid">
				{#each resourceOptions as opt}
					{@const Icon = opt.icon}
					<button class="res-card" class:res-card--on={selectedResource === opt.id} onclick={() => selectedResource = opt.id}>
						<div class="res-icon" style="background:color-mix(in srgb, {opt.color} 12%, transparent)">
							<Icon size={20} style="color:{opt.color}" />
						</div>
						<div class="res-text">
							<span class="res-label">{opt.label}</span>
							<span class="res-desc">{opt.desc}</span>
						</div>
						{#if selectedResource === opt.id}
							<div class="res-check"><Check size={12} /></div>
						{/if}
					</button>
				{/each}
			</div>
		</section>

		<!-- Where -->
		<section class="sec">
			<h2 class="sec-title">Which project?</h2>
			<p class="sec-desc">A project groups related deployments, databases, and ingresses together.</p>

			<div class="card">
				<!-- Tabs -->
				<div class="tabs">
					{#if projects.length > 0}
						<button class="tab" class:tab--on={mode === 'existing'} onclick={() => mode = 'existing'}>Existing project</button>
					{/if}
					<button class="tab" class:tab--on={mode === 'new'} onclick={() => mode = 'new'}>
						<Plus size={12} /> Create new
					</button>
				</div>

				<div class="card-body">
					{#if mode === 'existing'}
						{#if projects.length > 0}
							<div class="proj-list">
								{#each projects as p, i}
									<button class="proj-item" class:proj-item--on={selectedProjectIdx === i} onclick={() => selectedProjectIdx = i}>
										<div class="proj-item-dot" class:proj-item-dot--on={selectedProjectIdx === i}></div>
										<span class="proj-item-name">{p.projName}</span>
									</button>
								{/each}
							</div>
						{:else}
							<p class="hint">No projects yet. Create one to get started.</p>
						{/if}
					{:else}
						<div class="field">
							<label class="field-label" for="proj-name">Project name</label>
							<input id="proj-name" type="text" class="input" bind:value={newProjectName} placeholder="My Project" />
							<span class="field-hint">This will create a new project where you can add deployments, databases, and ingresses.</span>
						</div>
					{/if}
				</div>
			</div>
		</section>

		<!-- Go -->
		<div class="actions">
			<button class="btn btn--ghost" onclick={() => goto(`/${orgSlug}`)}>Cancel</button>
			<button class="btn btn--primary" onclick={proceed} disabled={!canProceed || creating}>
				{#if creating}<Loader2 size={14} class="spin" />{/if}
				Continue <ChevronRight size={15} />
			</button>
		</div>
	{/if}
</div>

<style>
	.pg { max-width: 38rem; margin: 0 auto; padding: 2rem 2rem 3rem; }

	.back {
		display: inline-flex; align-items: center; gap: 0.375rem;
		font-size: 0.8125rem; color: var(--surface-muted); background: none; border: none;
		cursor: pointer; padding: 0; margin-bottom: 1.5rem; transition: color 0.12s;
	}
	.back:hover { color: var(--center-channel-color); }

	.head { display: flex; align-items: center; gap: 1rem; margin-bottom: 2rem; }
	.head-icon {
		width: 3rem; height: 3rem; border-radius: 0.875rem; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.head-title { font-size: 1.25rem; font-weight: 700; color: var(--center-channel-color); margin: 0; letter-spacing: -0.02em; }
	.head-sub { font-size: 0.875rem; color: var(--surface-muted); margin: 0.25rem 0 0; }

	.sec { margin-bottom: 2rem; }
	.sec-title { font-size: 0.875rem; font-weight: 600; color: var(--center-channel-color); margin: 0 0 0.375rem; }
	.sec-desc { font-size: 0.8125rem; color: var(--surface-muted); margin: 0 0 1rem; }

	/* Resource cards */
	.res-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
	.res-card {
		display: flex; align-items: center; gap: 0.75rem;
		padding: 0.875rem 1rem; border-radius: 0.75rem; text-align: left; position: relative;
		border: 1px solid var(--surface-border); background: var(--center-channel-bg);
		cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
	}
	.res-card:hover { border-color: color-mix(in srgb, var(--sidebar-text-active-border) 40%, var(--surface-border)); }
	.res-card--on { border-color: var(--sidebar-text-active-border); box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent); }
	.res-icon { width: 2.5rem; height: 2.5rem; border-radius: 0.625rem; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
	.res-text { flex: 1; display: flex; flex-direction: column; gap: 0.125rem; }
	.res-label { font-size: 0.8125rem; font-weight: 600; color: var(--center-channel-color); }
	.res-desc { font-size: 0.6875rem; color: var(--surface-muted); }
	.res-check { width: 1.25rem; height: 1.25rem; border-radius: 50%; background: var(--sidebar-text-active-border); color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }

	/* Card */
	.card {
		border-radius: 0.75rem; overflow: hidden; background: var(--center-channel-bg);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-border) 60%, transparent), 0 1px 3px rgba(0,0,0,0.03);
	}
	.card-loading { display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 2rem; color: var(--surface-muted); font-size: 0.8125rem; }
	.card-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }

	/* Tabs */
	.tabs { display: flex; box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--surface-border) 50%, transparent); }
	.tab {
		flex: 1; padding: 0.625rem 0.75rem; font-size: 0.8125rem; font-weight: 500; text-align: center;
		color: var(--surface-muted); background: none; border: none;
		border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.12s;
		display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;
	}
	.tab:hover { color: var(--center-channel-color); }
	.tab--on { color: var(--sidebar-text-active-border); border-bottom-color: var(--sidebar-text-active-border); }

	/* Project list */
	.proj-list { display: flex; flex-direction: column; gap: 0.125rem; }
	.proj-item {
		display: flex; align-items: center; gap: 0.625rem;
		padding: 0.5rem 0.625rem; border-radius: 0.375rem;
		border: none; background: none; color: var(--center-channel-color);
		font-size: 0.8125rem; cursor: pointer; text-align: left; transition: background 0.1s;
	}
	.proj-item:hover { background: color-mix(in srgb, var(--surface-border) 25%, transparent); }
	.proj-item--on { background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent); }
	.proj-item-dot {
		width: 0.75rem; height: 0.75rem; border-radius: 50%; flex-shrink: 0;
		border: 2px solid var(--surface-border); transition: all 0.12s;
	}
	.proj-item-dot--on { border-color: var(--sidebar-text-active-border); background: var(--sidebar-text-active-border); box-shadow: inset 0 0 0 2px var(--center-channel-bg); }
	.proj-item-name { font-weight: 500; }

	/* Field */
	.field { display: flex; flex-direction: column; gap: 0.375rem; }
	.field-label { font-size: 0.8125rem; font-weight: 500; color: var(--surface-muted); }
	.field-hint { font-size: 0.6875rem; color: var(--surface-muted); line-height: 1.4; }
	.input {
		width: 100%; padding: 0.5rem 0.75rem; border-radius: 0.5rem;
		border: 1px solid var(--surface-border); background: var(--center-channel-bg);
		color: var(--center-channel-color); font-size: 0.8125rem;
	}
	.input::placeholder { color: var(--surface-muted); }
	.input:focus { outline: none; border-color: var(--sidebar-text-active-border); }

	.hint { font-size: 0.8125rem; color: var(--surface-muted); margin: 0; }

	/* Actions */
	.actions { display: flex; justify-content: flex-end; gap: 0.625rem; padding-top: 0.5rem; }
	.btn {
		display: inline-flex; align-items: center; gap: 0.375rem;
		padding: 0.5rem 1rem; border-radius: 0.5rem; font-size: 0.8125rem; font-weight: 600;
		border: none; cursor: pointer; transition: all 0.15s; white-space: nowrap;
	}
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn--primary { background: var(--sidebar-text-active-border); color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
	.btn--primary:hover:not(:disabled) { opacity: 0.95; }
	.btn--ghost { background: none; color: var(--surface-muted); border: 1px solid var(--surface-border); }
	.btn--ghost:hover:not(:disabled) { color: var(--center-channel-color); }

	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

	@media (max-width: 640px) { .res-grid { grid-template-columns: 1fr; } }
</style>
