<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { apiFetch, selectedOrganization } from '$lib/stores';
	import { ChevronDown, Check, Plus, X, Sparkles } from 'lucide-svelte';
	import { onMount, tick } from 'svelte';
	import { scale } from 'svelte/transition';

	interface Props {
		currentProjectName: string;
		/** The suffix to append after the project base path, e.g. "/deployments/new?source=github" */
		pathSuffix: string;
		/**
		 * Name of a project the user wants to create but which hasn't been persisted yet.
		 * When set, the trigger shows this name instead of the current project.
		 * Parent is responsible for actually creating the project (e.g. on form submit).
		 */
		pendingProjectName?: string | null;
		/** Called when the user stages or clears a pending project name. */
		onPendingProjectChange?: (name: string | null) => void;
	}

	let {
		currentProjectName,
		pathSuffix,
		pendingProjectName = null,
		onPendingProjectChange
	}: Props = $props();

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

	let creating = $state(false);
	let newName = $state('');
	let createError = $state<string | null>(null);
	let nameInputEl = $state<HTMLInputElement | null>(null);

	let triggerEl = $state<HTMLElement | null>(null);
	let menuPos = $state<{ top: number; left: number; minWidth: number }>({ top: 0, left: 0, minWidth: 0 });

	function updateMenuPos() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		menuPos = {
			top: rect.bottom + 4,
			left: rect.left,
			minWidth: rect.width
		};
	}

	$effect(() => {
		if (!open) return;
		updateMenuPos();
		const onScrollOrResize = () => updateMenuPos();
		window.addEventListener('scroll', onScrollOrResize, true);
		window.addEventListener('resize', onScrollOrResize);
		return () => {
			window.removeEventListener('scroll', onScrollOrResize, true);
			window.removeEventListener('resize', onScrollOrResize);
		};
	});

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
		// Switching away from a pending new project clears it.
		if (pendingProjectName) onPendingProjectChange?.(null);
		if (slug === currentSlug) return;
		goto(`/${orgSlug}/projects/${slug}${pathSuffix}`);
	}

	async function beginCreate() {
		creating = true;
		createError = null;
		newName = pendingProjectName ?? '';
		await tick();
		nameInputEl?.focus();
		nameInputEl?.select();
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
		creating = false;
		newName = '';
		createError = null;
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
			cancelCreate();
		}
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		// Ignore clicks on elements that were removed from the DOM mid-handler
		// (e.g. a menu item that got unmounted by its own click handler before the
		// document-level listener ran). Without this guard, closest() returns null
		// on the detached node and we'd incorrectly close the menu.
		if (!target.isConnected) return;
		if (target.closest('.ps-root') || target.closest('.ps-menu')) return;
		open = false;
		if (creating) cancelCreate();
	}

	onMount(() => {
		fetchProjects();
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});
</script>

<div class="ps-root">
	<div bind:this={triggerEl} class="ps-trigger" class:ps-trigger-pending={pendingProjectName}>
		<button type="button" class="ps-trigger-main" onclick={() => open = !open}>
			<span class="ps-label">Project</span>
			{#if pendingProjectName}
				<Sparkles size={12} class="ps-pending-icon" />
			{/if}
			<span class="ps-value" class:ps-value-pending={pendingProjectName}>{pendingProjectName || currentProjectName}</span>
			<ChevronDown size={14} class="ps-chevron" />
		</button>
		{#if pendingProjectName}
			<button
				type="button"
				class="ps-pending-clear"
				onclick={clearPending}
				aria-label="Discard new project"
				title="Discard"
			>
				<X size={12} />
			</button>
		{/if}
	</div>

	{#if open && loaded}
		<div
			class="ps-menu"
			class:ps-menu-creating={creating}
			style="top: {menuPos.top}px; left: {menuPos.left}px; --ps-menu-trigger-width: {menuPos.minWidth}px;"
			transition:scale={{ duration: 120, start: 0.96 }}
		>
			{#if !creating}
				<button class="ps-option ps-option-create" onclick={beginCreate}>
					<Plus size={14} />
					<span class="ps-option-name">New project</span>
				</button>
			{:else}
				<div class="ps-create">
					<div class="ps-create-row">
						<input
							bind:this={nameInputEl}
							bind:value={newName}
							onkeydown={handleCreateKey}
							placeholder="Project name"
							class="ps-create-input"
						/>
						<button
							class="ps-create-icon ps-create-confirm"
							onclick={stagePendingProject}
							disabled={!newName.trim()}
							type="button"
							aria-label="Use this project name"
							title="Use this name"
						>
							<Check size={14} />
						</button>
						<button
							class="ps-create-icon ps-create-cancel-icon"
							onclick={cancelCreate}
							type="button"
							aria-label="Cancel"
							title="Cancel"
						>
							<X size={14} />
						</button>
					</div>
					{#if createError}
						<p class="ps-create-error">{createError}</p>
					{/if}
				</div>
			{/if}

			<div class="ps-divider"></div>

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
		align-items: stretch;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		transition: border-color 0.15s, background-color 0.15s;
		font-size: 0.75rem;
		overflow: hidden;
	}

	.ps-trigger:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.ps-trigger-pending {
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 50%, var(--surface-border));
		background: color-mix(in srgb, var(--sidebar-text-active-border) 6%, var(--center-channel-bg));
	}

	.ps-trigger-main {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.625rem;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	.ps-pending-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.5rem;
		background: transparent;
		border: none;
		border-left: 1px solid color-mix(in srgb, var(--sidebar-text-active-border) 30%, var(--surface-border));
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.1s, background-color 0.1s;
	}

	.ps-pending-clear:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
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

	.ps-value-pending {
		color: var(--sidebar-text-active-border);
		font-style: italic;
	}

	:global(.ps-pending-icon) {
		color: var(--sidebar-text-active-border);
	}

	:global(.ps-chevron) {
		color: var(--surface-muted);
	}

	.ps-menu {
		position: fixed;
		z-index: 1000;
		min-width: max(12rem, var(--ps-menu-trigger-width, 12rem));
		max-width: 18rem;
		max-height: 16rem;
		overflow-y: auto;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		padding: 0.375rem;
		background-color: var(--surface-bg);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
		transform-origin: top left;
		transition: min-width 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.ps-menu-creating {
		min-width: 18rem;
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

	.ps-divider {
		height: 1px;
		margin: 0.375rem 0.25rem;
		background-color: var(--surface-border);
		opacity: 0.6;
	}

	.ps-option-create {
		gap: 0.5rem;
		justify-content: flex-start;
		color: var(--surface-muted);
	}

	.ps-option-create:hover {
		color: var(--center-channel-color);
	}

	.ps-create {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.375rem 0.5rem 0.5rem;
	}

	.ps-create-input {
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		outline: none;
		transition: border-color 0.15s;
	}

	.ps-create-input:focus {
		border-color: var(--sidebar-text-active-border);
	}

	.ps-create-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.ps-create-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		animation: ps-create-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes ps-create-in {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.ps-create-row .ps-create-input {
		flex: 1;
		min-width: 0;
	}

	.ps-create-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--surface-muted);
		cursor: pointer;
		transition: background-color 0.1s, border-color 0.1s, color 0.1s, opacity 0.1s;
	}

	.ps-create-icon:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ps-create-confirm:not(:disabled) {
		color: var(--sidebar-text-active-border);
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 40%, var(--surface-border));
	}

	.ps-create-confirm:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		border-color: var(--sidebar-text-active-border);
	}

	.ps-create-cancel-icon:hover:not(:disabled) {
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.ps-create-error {
		margin: 0;
		font-size: 0.75rem;
		color: var(--error-text, #e03e3e);
	}

</style>
