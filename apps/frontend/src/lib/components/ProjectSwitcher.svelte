<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { apiFetch, selectedOrganization } from '$lib/stores';
	import { Check, Plus, Sparkles } from 'lucide-svelte';
	import { tick } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Button, Input, Menu, MenuItem, SelectTrigger } from '$lib/components/ui';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';

	interface Props {
		currentProjectName: string;
		pathSuffix: string;
		pendingProjectName?: string | null;
		onPendingProjectChange?: (name: string | null) => void;
		block?: boolean;
	}

	let {
		currentProjectName,
		pathSuffix,
		pendingProjectName = null,
		onPendingProjectChange,
		block = false
	}: Props = $props();

	const orgSlug = $derived($page.params.orgSlug ?? '');
	const currentSlug = $derived($page.params.projectSlug ?? '');

	interface ProjectItem {
		id: string;
		name: string;
		slug: string;
	}

	const orgId = $derived($selectedOrganization?.id ?? null);

	const canCreateProject = $derived(
		!!onPendingProjectChange && !!$selectedOrganization && $selectedOrganization.myRole !== 'guest'
	);

	const projectsQuery = createQuery<ProjectItem[]>(() => ({
		queryKey: ['projects', orgId],
		enabled: !!orgId,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/projects?orgId=${orgId}`);
			if (!res.ok) throw new Error(`projects ${res.status}`);
			const list = await res.json();
			return list.map((p: any) => ({ id: p.id, name: p.name, slug: p.slug }));
		}
	}));

	const projects = $derived(projectsQuery.data ?? []);
	const loaded = $derived(projectsQuery.data !== undefined);

	let open = $state(false);
	let creating = $state(false);
	let newName = $state('');
	let createError = $state<string | null>(null);
	let createEl = $state<HTMLElement | null>(null);

	function setOpen(next: boolean) {
		open = next;
		if (!next && creating) cancelCreate();
	}

	function switchProject(slug: string) {
		if (pendingProjectName) onPendingProjectChange?.(null);
		if (slug === currentSlug) return;
		goto(`/${orgSlug}/projects/${slug}${pathSuffix}`);
	}

	async function beginCreate() {
		creating = true;
		createError = null;
		newName = pendingProjectName ?? '';
		await tick();
		const input = createEl?.querySelector('input');
		input?.focus();
		input?.select();
	}

	function cancelCreate() {
		creating = false;
		newName = '';
		createError = null;
	}

	function stagePendingProject() {
		const name = newName.trim();
		if (!name) {
			createError = 'Project name is required';
			return;
		}
		if ($selectedOrganization?.id == null) {
			createError = 'No organization selected';
			return;
		}
		onPendingProjectChange?.(name);
		cancelCreate();
		open = false;
	}

	function clearPending() {
		onPendingProjectChange?.(null);
	}

	function handleCreateKey(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			stagePendingProject();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			cancelCreate();
		}
	}
</script>

<Menu
	placement="bottom-start"
	size="lg"
	sameWidth={block}
	bind:open={() => open, setOpen}
	inside={(target) => target instanceof Node && !target.isConnected}
>
	{#snippet trigger(attrs, isOpen)}
		<SelectTrigger
			{...attrs}
			open={isOpen}
			{block}
			prefix={block ? undefined : 'Project'}
			value={pendingProjectName || currentProjectName}
			loading={!loaded && projectsQuery.isFetching}
			onclear={pendingProjectName ? clearPending : undefined}
		>
			{#snippet leading()}
				{#if pendingProjectName}
					<span class="ps-pending"><Sparkles size={14} /></span>
				{:else}
					<AppIcon name={currentProjectName} kind="project" size="xs" />
				{/if}
			{/snippet}
		</SelectTrigger>
	{/snippet}

	<MenuLabel>Switch project</MenuLabel>
	{#each projects as p (p.id)}
		<MenuItem
			checked={!pendingProjectName && p.slug === currentSlug}
			onclick={() => switchProject(p.slug)}
		>
			{#snippet leading()}<AppIcon name={p.name} kind="project" size="sm" />{/snippet}
			{p.name}
		</MenuItem>
	{/each}

	{#if canCreateProject}
		<MenuSeparator />
		{#if creating}
			<div class="ps-create" bind:this={createEl}>
				<div class="ps-create-row">
					<Input
						size="sm"
						bind:value={newName}
						placeholder="Project name"
						aria-label="New project name"
						error={!!createError}
						onkeydown={handleCreateKey}
					/>
					<Button
						variant="tinted"
						size="sm"
						icon={Check}
						label="Use this name"
						disabled={!newName.trim()}
						onclick={stagePendingProject}
					/>
				</div>
				{#if createError}<p class="ps-create-error" role="alert">{createError}</p>{/if}
			</div>
		{:else}
			<MenuItem icon={Plus} keepOpen onclick={beginCreate}>
				{pendingProjectName ? 'Rename new project' : 'New project'}
			</MenuItem>
		{/if}
	{/if}
</Menu>

<style>
	.ps-pending {
		display: inline-flex;
		color: var(--accent);
	}
	.ps-create {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.25rem;
	}
	.ps-create-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.ps-create-row > :global(:first-child) {
		flex: 1;
		min-width: 0;
	}
	.ps-create-error {
		margin: 0;
		padding: 0 0.25rem;
		color: var(--status-error);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
</style>
