<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Settings2, Plus } from 'lucide-svelte';
	import { environmentsQueryOptions } from '$lib/queries/environments';
	import { Badge, Menu, MenuItem, SelectTrigger } from '$lib/components/ui';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import { envDotColor } from '$lib/utils/format';
	import type { Environment } from '$lib/types/environments';
	import ManageEnvironmentsModal from './ManageEnvironmentsModal.svelte';

	let {
		projectId,
		selectedEnvId = $bindable(''),
		block = false,
		placement = 'bottom-start'
	}: {
		projectId: string;
		selectedEnvId?: string;
		block?: boolean;
		placement?: 'bottom-start' | 'bottom-end';
	} = $props();

	const envQuery = createQuery(() => ({
		...environmentsQueryOptions(projectId),
		enabled: !!projectId
	}));
	const environments = $derived((envQuery.data ?? []) as Environment[]);

	let defaultedFor: string | null = null;
	$effect(() => {
		if (environments.length === 0) return;
		if (defaultedFor === projectId) return;
		if (!selectedEnvId || !environments.some((e) => e.id === selectedEnvId)) {
			selectedEnvId = (environments.find((e) => e.isDefault) ?? environments[0]).id;
		}
		defaultedFor = projectId;
	});

	const selectedEnv = $derived(environments.find((e) => e.id === selectedEnvId) ?? null);
	let manageOpen = $state(false);
</script>

<Menu {placement} size="lg" sameWidth={block}>
	{#snippet trigger(attrs, isOpen)}
		<SelectTrigger
			{...attrs}
			open={isOpen}
			{block}
			value={selectedEnv?.name}
			placeholder="Environment"
			loading={envQuery.isLoading}
		>
			{#snippet leading()}
				<span
					class="env-dot"
					style:--env-c={selectedEnv ? envDotColor(selectedEnv.slug) : 'var(--neutral-6)'}
				></span>
			{/snippet}
		</SelectTrigger>
	{/snippet}

	{#each environments as env (env.id)}
		<MenuItem checked={env.id === selectedEnvId} onclick={() => (selectedEnvId = env.id)}>
			{#snippet leading()}
				<span class="env-tile" style:--env-c={envDotColor(env.slug)}
					><span class="env-dot"></span></span
				>
			{/snippet}
			<span class="env-name">
				<span class="env-label">{env.name}</span>
				{#if env.isDefault}<Badge>Default</Badge>{/if}
			</span>
		</MenuItem>
	{/each}
	<MenuSeparator />
	<MenuItem icon={Settings2} onclick={() => (manageOpen = true)}>Manage environments</MenuItem>
	<MenuItem icon={Plus} onclick={() => (manageOpen = true)}>New environment</MenuItem>
</Menu>

<ManageEnvironmentsModal bind:open={manageOpen} {projectId} />

<style>
	.env-dot {
		display: block;
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--env-c);
	}
	.env-tile {
		display: grid;
		place-items: center;
		background: color-mix(in oklab, var(--env-c) 14%, transparent);
	}
	.env-name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.env-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
