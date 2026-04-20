<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { apiFetch, selectedOrganization } from '$lib/stores';
	import { ChevronDown, Check, Plus } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { scale } from 'svelte/transition';

	interface Props {
		currentProjectName: string;
		/** The suffix to append after the project base path, e.g. "/deployments/new?source=github" */
		pathSuffix: string;
	}

	let { currentProjectName, pathSuffix }: Props = $props();

	const orgSlug = $derived($page.params.orgSlug ?? '');
	const currentSlug = $derived($page.params.projectSlug ?? '');

	interface ProjectItem {
		id: string;
		name: string;
		slug: string;
	}

	let projects = $state<ProjectItem[]>([]);
	let open = $state(false);
	let loaded = $state(false);

	async function fetchProjects() {
		const orgId = $selectedOrganization?.id;
		if (!orgId) return;
		try {
			const res = await apiFetch(`/apiv1/projects?orgId=${orgId}`);
			if (res.ok) {
				projects = (await res.json()).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug }));
			}
		} catch { /* */ }
		finally { loaded = true; }
	}

	function switchProject(slug: string) {
		open = false;
		if (slug === currentSlug) return;
		goto(`/${orgSlug}/projects/${slug}${pathSuffix}`);
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.ps-root')) {
			open = false;
		}
	}

	onMount(() => {
		fetchProjects();
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});
</script>

<div class="ps-root">
	<button class="ps-trigger" onclick={() => open = !open}>
		<span class="ps-label">Project</span>
		<span class="ps-value">{currentProjectName}</span>
		<ChevronDown size={14} class="ps-chevron" />
	</button>

	{#if open && loaded}
		<div class="ps-menu" transition:scale={{ duration: 120, start: 0.96 }}>
			{#each projects as p}
				<button
					class="ps-option"
					class:ps-option-active={p.slug === currentSlug}
					onclick={() => switchProject(p.slug)}
				>
					<span class="ps-option-name">{p.name}</span>
					{#if p.slug === currentSlug}
						<Check size={14} style="color: var(--sidebar-text-active-border);" />
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.ps-root {
		position: relative;
		display: inline-block;
	}

	.ps-trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		cursor: pointer;
		transition: border-color 0.15s;
		font-size: 0.75rem;
	}

	.ps-trigger:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.ps-label {
		color: var(--surface-muted);
		font-weight: 500;
	}

	.ps-value {
		color: var(--center-channel-color);
		font-weight: 600;
		max-width: 10rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	:global(.ps-chevron) {
		color: var(--surface-muted);
	}

	.ps-menu {
		position: absolute;
		z-index: 30;
		top: 100%;
		left: 0;
		margin-top: 0.25rem;
		min-width: 12rem;
		max-width: 18rem;
		max-height: 16rem;
		overflow-y: auto;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		padding: 0.375rem;
		background-color: var(--surface-bg);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
	}

	.ps-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		border-radius: 0.375rem;
		padding: 0.4375rem 0.625rem;
		text-align: left;
		font-size: 0.8125rem;
		border: none;
		background: none;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color 0.1s;
	}

	.ps-option:hover {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.ps-option-active {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
	}

	.ps-option-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
