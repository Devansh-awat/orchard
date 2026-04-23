<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import { Loader2, Users, Building2, Package, Rocket } from 'lucide-svelte';

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

	const statCards = $derived(
		stats
			? [
					{ label: 'Users', value: stats.userCount, icon: Users, href: '/admin/users' },
					{ label: 'Organizations', value: stats.orgCount, icon: Building2, href: '/admin/organizations' },
					{ label: 'Projects', value: stats.projectCount, icon: Package, href: null },
					{ label: 'Deployments', value: stats.deploymentCount, icon: Rocket, href: null },
				].filter((c) => typeof c.value === 'number')
			: []
	);

	async function fetchStats() {
		loading = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/admin/stats');
			if (!response.ok) throw new Error('Failed to fetch stats');
			stats = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch stats';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchStats();
	});
</script>

{#if loading}
	<div class="flex justify-center py-12">
		<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
	</div>
{:else if error}
	<div class="alert alert-error">{error}</div>
{:else}
	<div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
		{#each statCards as card}
			{@const Tag = card.href ? 'a' : 'div'}
			<svelte:element
				this={Tag}
				href={card.href}
				class="rounded-2xl border p-5 transition hover:-translate-y-0.5 hover:shadow-md"
				style="border-color: var(--surface-border); background-color: var(--surface-bg); color: var(--center-channel-color);"
			>
				<div class="flex items-center gap-3 mb-3">
					<div
						class="flex h-9 w-9 items-center justify-center rounded-xl"
						style="background-color: var(--control-bg); color: var(--surface-muted);"
					>
						<svelte:component this={card.icon} class="h-4 w-4" />
					</div>
				</div>
				<p class="text-3xl font-bold" style="color: var(--center-channel-color);">
					{card.value.toLocaleString()}
				</p>
				<p class="text-sm mt-1" style="color: var(--surface-muted);">{card.label}</p>
			</svelte:element>
		{/each}
	</div>
{/if}
