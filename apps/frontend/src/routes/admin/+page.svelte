<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import { Users, Building2, Package, Rocket } from 'lucide-svelte';
	import { Alert, Skeleton } from '$lib/components/ui';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import { SetupChecklist } from '$lib/components/setup';

	interface Stats {
		userCount: number;
		orgCount: number;
		workspaceCount?: number;
		projectCount: number;
		deploymentCount: number;
	}

	let stats = $state<Stats | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const tiles = $derived(
		stats
			? [
					{ label: 'Users', value: stats.userCount, icon: Users, href: '/admin/users' },
					{
						label: 'Organizations',
						value: stats.orgCount,
						icon: Building2,
						href: '/admin/organizations'
					},
					{ label: 'Projects', value: stats.projectCount, icon: Package, href: null },
					{ label: 'Deployments', value: stats.deploymentCount, icon: Rocket, href: null }
				].filter((tile) => typeof tile.value === 'number')
			: []
	);

	onMount(async () => {
		try {
			const response = await apiFetch('/apiv1/admin/stats');
			if (!response.ok) throw new Error('Could not load instance stats');
			stats = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load instance stats';
		} finally {
			loading = false;
		}
	});
</script>

<SetupChecklist />

<section class="tiles-section" {@attach motionStagger({ index: 1 })}>
	<p class="tiles-label">What is running here</p>

	{#if loading}
		<Skeleton class="h-20 w-full" />
	{:else if error}
		<Alert tone="error" title="Could not load instance stats">{error}</Alert>
	{:else}
		<div class="tiles">
			{#each tiles as tile (tile.label)}
				{@const Icon = tile.icon}
				<svelte:element
					this={tile.href ? 'a' : 'div'}
					href={tile.href ?? undefined}
					class="tile"
					class:tile--link={!!tile.href}
					{@attach springHover()}
				>
					<span class="tile-icon"><Icon size={14} /></span>
					<span class="tile-value">{tile.value.toLocaleString()}</span>
					<span class="tile-label">{tile.label}</span>
				</svelte:element>
			{/each}
		</div>
	{/if}
</section>

<style>
	.tiles-section {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.tiles-label {
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.5rem;
	}

	.tile {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.7rem 0.85rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-surface);
		color: inherit;
		text-decoration: none;
	}

	.tile--link:hover {
		border-color: var(--accent);
	}

	.tile-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.tile-value {
		font-size: var(--text-title-3);
		font-weight: 650;
		line-height: 1;
		color: var(--text-fg);
		font-variant-numeric: tabular-nums;
	}

	.tile-label {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
