<script lang="ts">
	import { organizations, selectedOrganization, type Organization } from '$lib/stores';
	import { goto } from '$app/navigation';
	import { Building2 } from 'lucide-svelte';
	import { ChevronsUpDown, X, Settings, FolderKanban } from '@jis3r/icons';
	import { Collapsible } from 'melt/components';
	import {
		motionPopover,
		motionStagger as motionStaggerBase,
		springHover as springHoverBase,
		springRotate as springRotateBase
	} from '$lib/utils/motion.svelte';

	interface Props {
		collapsed?: boolean;
	}
	let { collapsed = false }: Props = $props();

	let open = $state(false);
	let render = $state(false);
	$effect(() => {
		if (open) render = true;
	});

	function selectOrg(org: Organization) {
		organizations.setSelected(org);
		open = false;
		goto(`/${org.slug}`);
	}

	function motionStagger(index: number, stride = 0.035) {
		return motionStaggerBase({ index, stride, from: { y: -6, opacity: 0, scale: 1 } });
	}

	function springHover(opts: { lift?: number; stiffness?: number; damping?: number } = {}) {
		return springHoverBase({ lift: -1, forwardIconHover: true, ...opts });
	}

	function springRotate(active: () => boolean, on = 180) {
		return springRotateBase(active, { rest: 0, on, damping: 24 });
	}
</script>

<Collapsible bind:open>
	{#snippet children(collapsible)}
		<div class="workspaces-menu" class:is-collapsed={collapsed}>
			{#if collapsed}
				<button
					type="button"
					aria-label="Toggle organization menu"
					{...collapsible.trigger}
					class="org-menu-trigger-collapsed"
					class:is-open={collapsible.open}
					{@attach springHover()}
				>
					{#if $selectedOrganization?.avatarUrl}
						<img
							src={$selectedOrganization.avatarUrl}
							alt={$selectedOrganization.name}
							class="sidebar-org-avatar"
						/>
					{:else}
						<div class="sidebar-org-avatar-fallback">
							<FolderKanban size={16} />
						</div>
					{/if}
					{#if !collapsible.open}
						<span class="sidebar-collapsed-tooltip">
							{$selectedOrganization?.name ?? 'Select organization'}
						</span>
					{/if}
				</button>
			{:else}
				<button
					type="button"
					aria-label="Toggle organization menu"
					{...collapsible.trigger}
					class="org-menu-trigger relative z-10"
					{@attach springHover({ lift: -1 })}
				>
					<div class="flex items-center gap-3 min-w-0 flex-1">
						{#if $selectedOrganization}
							{#if $selectedOrganization.avatarUrl}
								<img
									src={$selectedOrganization.avatarUrl}
									alt={$selectedOrganization.name}
									class="org-menu-trigger-avatar"
								/>
							{:else}
								<div class="org-menu-trigger-icon">
									<Building2 class="h-4 w-4" />
								</div>
							{/if}
							<span class="org-menu-trigger-name">{$selectedOrganization.name}</span>
						{:else}
							<div class="org-menu-trigger-icon">
								<Building2 class="h-4 w-4" />
							</div>
							<span class="org-menu-trigger-placeholder">Select organization</span>
						{/if}
					</div>
					<span
						class="org-menu-trigger-chevron"
						class:is-open={collapsible.open}
						{@attach springRotate(() => !!collapsible.open, 180)}
					>
						{#if collapsible.open}
							<X size={16} />
						{:else}
							<ChevronsUpDown size={16} />
						{/if}
					</span>
				</button>
			{/if}

			{#if render}
				<div
					{...collapsible.content}
					class="org-menu-panel"
					class:org-menu-panel-collapsed={collapsed}
					style:transform-origin="top left"
					{@attach motionPopover({
						from: { y: -8, scale: 0.96 },
						stiffness: 540,
						damping: 30,
						closing: () => !open,
						onClosed: () => {
							render = false;
						}
					})}
				>
					<div class="org-menu-list">
						{#each $organizations as org, i (org.id)}
							<button
								type="button"
								onclick={() => selectOrg(org)}
								class="org-menu-item"
								{@attach motionStagger(i)}
								{@attach springHover({ lift: -1 })}
							>
								{#if org.avatarUrl}
									<img src={org.avatarUrl} alt={org.name} class="org-menu-item-avatar" />
								{:else}
									<div class="org-menu-item-icon">
										<Building2 class="h-3 w-3" />
									</div>
								{/if}
								<span class="org-menu-item-name">{org.name}</span>
								{#if $selectedOrganization?.id === org.id}
									<span class="org-menu-item-dot"></span>
								{/if}
							</button>
						{/each}
					</div>
					{#if $selectedOrganization}
						<div class="org-menu-footer">
							<a
								href="/{$selectedOrganization.slug}/settings"
								{@attach motionStagger($organizations.length)}
								{@attach springHover({ lift: -1 })}
							>
								<Settings size={16} />
								Organization Settings
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Collapsible>

<style>
	.workspaces-menu {
		position: relative;
		width: 100%;
	}

	.workspaces-menu.is-collapsed {
		width: auto;
	}

	.org-menu-trigger {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border-radius: 0.75rem;
		padding: 0.625rem 0.75rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		font-weight: 500;
		text-align: left;
		background-color: transparent;
		color: var(--sidebar-text);
		transition: background-color 150ms ease;
	}

	.org-menu-trigger:hover {
		background-color: var(--sidebar-text-hover-bg);
	}

	.org-menu-trigger-avatar {
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		border-radius: 0.5rem;
		object-fit: cover;
	}

	.org-menu-trigger-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--sidebar-text) 15%, transparent);
		color: var(--sidebar-text);
	}

	.org-menu-trigger-name {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
		font-size: 0.875rem;
		line-height: 1.25rem;
		font-weight: 500;
		color: var(--sidebar-text);
	}

	.org-menu-trigger-placeholder {
		font-size: 0.875rem;
		color: color-mix(in srgb, var(--sidebar-text) 55%, transparent);
	}

	.org-menu-trigger-chevron {
		color: color-mix(in srgb, var(--sidebar-text) 45%, transparent);
		flex-shrink: 0;
	}

	.org-menu-trigger-collapsed {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border-radius: 0.75rem;
		background-color: transparent;
		color: var(--sidebar-text);
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
		cursor: pointer;
	}
	.org-menu-trigger-collapsed:hover {
		background-color: var(--sidebar-text-hover-bg);
	}
	.org-menu-trigger-collapsed.is-open {
		background-color: var(--sidebar-text-active-bg);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 40%, transparent);
	}
	.org-menu-trigger-collapsed:hover .sidebar-collapsed-tooltip {
		opacity: 1;
	}

	.org-menu-panel {
		position: absolute;
		left: 0;
		top: 100%;
		margin-top: 0.375rem;
		width: 100%;
		z-index: 100;
		display: flex;
		flex-direction: column;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		padding: 0.75rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow:
			0 4px 6px rgb(0 0 0 / 0.04),
			0 12px 32px rgb(0 0 0 / 0.1);
	}

	.org-menu-panel.org-menu-panel-collapsed {
		left: calc(100% + 0.5rem);
		top: 0;
		width: 16rem;
		margin-top: 0;
	}

	.org-menu-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.org-menu-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.75rem;
		border-radius: 0.5rem;
		padding: 0.625rem 0.75rem;
		text-align: left;
		font-size: 0.875rem;
		line-height: 1.25rem;
		color: var(--center-channel-color);
		min-width: 0;
		background: transparent;
		transition: background-color 120ms ease;
	}

	.org-menu-item:hover {
		background-color: var(--control-hover-bg);
	}

	.org-menu-item-avatar {
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border-radius: 0.25rem;
		object-fit: cover;
	}

	.org-menu-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--center-channel-color) 10%, transparent);
		color: var(--center-channel-color);
	}

	.org-menu-item-name {
		min-width: 0;
		flex: 1;
		overflow-wrap: break-word;
		text-align: left;
	}

	.org-menu-item-dot {
		width: 0.5rem;
		height: 0.5rem;
		flex-shrink: 0;
		border-radius: 9999px;
		background-color: var(--sidebar-text-active-border);
	}

	.org-menu-footer {
		margin-top: 0.25rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--surface-border);
	}

	.org-menu-footer a {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		color: var(--center-channel-color);
		background: transparent;
		transition: background-color 120ms ease;
	}

	.org-menu-footer a:hover {
		background-color: var(--control-hover-bg);
	}

	.sidebar-org-avatar {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.75rem;
		object-fit: cover;
	}

	.sidebar-org-avatar-fallback {
		display: flex;
		width: 2.25rem;
		height: 2.25rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
		color: var(--sidebar-text-active-border);
	}
</style>
