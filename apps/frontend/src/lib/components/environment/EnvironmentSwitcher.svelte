<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { ChevronDown, Check, Settings2, Plus } from 'lucide-svelte';
	import { environmentsQueryOptions } from '$lib/queries/environments';
	import { PopoverPanel } from '$lib/components/ui';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { envBadgeColor } from '$lib/utils/format';
	import type { Environment } from '$lib/types/environments';
	import ManageEnvironmentsModal from './ManageEnvironmentsModal.svelte';

	let {
		projectId,
		selectedEnvId = $bindable('')
	}: {
		projectId: string;
		selectedEnvId?: string;
	} = $props();

	const envQuery = createQuery(() => ({
		...environmentsQueryOptions(projectId),
		enabled: !!projectId
	}));
	const environments = $derived((envQuery.data ?? []) as Environment[]);

	let defaulted = false;
	$effect(() => {
		if (defaulted || environments.length === 0) return;
		if (!selectedEnvId || !environments.some((e) => e.id === selectedEnvId)) {
			selectedEnvId = (environments.find((e) => e.isDefault) ?? environments[0]).id;
		}
		defaulted = true;
	});

	const selectedEnv = $derived(environments.find((e) => e.id === selectedEnvId) ?? null);
	let manageOpen = $state(false);
</script>

<PopoverPanel placement="bottom-start">
	{#snippet trigger(props, isOpen)}
		<button
			type="button"
			class="env-pill"
			class:env-pill--open={isOpen}
			style="--env-c: {selectedEnv ? envBadgeColor(selectedEnv.slug) : 'var(--surface-muted)'}"
			{...props}
		>
			{#if selectedEnv}
				<span class="env-pill-dot"></span>
				<span class="env-pill-name">{selectedEnv.name}</span>
			{:else}
				<span class="env-pill-name env-pill-name--muted">Select…</span>
			{/if}
			<span class="env-pill-chev" {@attach springRotate(() => isOpen, { rest: 0, on: 180 })}
				><ChevronDown size={14} /></span
			>
		</button>
	{/snippet}
	{#snippet children({ close })}
		<div class="env-menu">
			{#each environments as env (env.id)}
				<button
					type="button"
					class="env-menu-item"
					class:env-menu-item--active={env.id === selectedEnvId}
					onclick={() => {
						selectedEnvId = env.id;
						close();
					}}
				>
					<span class="env-pill-dot" style="background-color: {envBadgeColor(env.slug)}"></span>
					<span class="env-menu-name">{env.name}</span>
					{#if env.isDefault}<span class="env-menu-default">default</span>{/if}
					{#if env.id === selectedEnvId}<Check size={14} class="env-menu-check" />{/if}
				</button>
			{/each}
			<div class="env-menu-divider"></div>
			<button
				type="button"
				class="env-menu-action"
				onclick={() => {
					manageOpen = true;
					close();
				}}
			>
				<Settings2 size={14} />
				Manage environments
			</button>
			<button
				type="button"
				class="env-menu-action"
				onclick={() => {
					manageOpen = true;
					close();
				}}
			>
				<Plus size={14} />
				New environment
			</button>
		</div>
	{/snippet}
</PopoverPanel>

<ManageEnvironmentsModal bind:open={manageOpen} {projectId} />

<style>
	.env-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		/* Fixed width so the tab bar layout never shifts with the env name;
		   longer names truncate with an ellipsis. */
		width: 9.5rem;
		height: 2.125rem;
		padding: 0 0.625rem 0 0.5rem;
		border-radius: 0.625rem;
		border: 1px solid color-mix(in srgb, var(--env-c) 30%, var(--surface-border));
		background: color-mix(in srgb, var(--env-c) 7%, var(--surface-bg));
		color: var(--center-channel-color);
		font-size: 0.85rem;
		font-weight: 600;
		transition:
			background-color 140ms cubic-bezier(0.32, 0.72, 0, 1),
			border-color 140ms cubic-bezier(0.32, 0.72, 0, 1);
	}
	.env-pill-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.env-pill-chev {
		display: inline-flex;
		flex-shrink: 0;
	}
	.env-pill:hover,
	.env-pill--open {
		background: color-mix(in srgb, var(--env-c) 12%, var(--surface-bg));
		border-color: color-mix(in srgb, var(--env-c) 45%, var(--surface-border));
	}
	.env-pill-dot {
		width: 9px;
		height: 9px;
		border-radius: 9999px;
		background: var(--env-c);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--env-c) 18%, transparent);
		flex-shrink: 0;
	}
	.env-pill-name--muted {
		color: var(--surface-muted);
	}
	.env-pill :global(svg) {
		color: var(--surface-muted);
	}
	.env-menu {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 13rem;
	}
	.env-menu-item,
	.env-menu-action {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		font-size: 0.82rem;
		color: var(--center-channel-color);
		text-align: left;
	}
	.env-menu-item:hover,
	.env-menu-action:hover {
		background: var(--control-bg);
	}
	.env-menu-item--active {
		font-weight: 600;
	}
	.env-menu-name {
		flex: 1;
	}
	.env-menu-default {
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}
	.env-menu-item :global(.env-menu-check) {
		color: var(--button-bg);
	}
	.env-menu-action {
		color: var(--surface-muted);
	}
	.env-menu-divider {
		height: 1px;
		background: var(--surface-border);
		margin: 0.3rem 0;
	}
</style>
