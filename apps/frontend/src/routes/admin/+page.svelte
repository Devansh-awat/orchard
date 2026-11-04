<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import { Alert, Card, SectionTitle, Skeleton, Stack, Swap } from '$lib/components/ui';
	import Metric from '$lib/components/ui/Metric.svelte';
	import { SetupChecklist } from '$lib/components/setup';

	interface Stats {
		userCount: number;
		orgCount: number;
		projectCount: number;
		deploymentCount: number;
	}

	let stats = $state<Stats | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const metrics = $derived(
		stats
			? [
					{ label: 'Users', value: stats.userCount, href: '/admin/users' },
					{ label: 'Organizations', value: stats.orgCount, href: '/admin/organizations' },
					{ label: 'Projects', value: stats.projectCount, href: undefined },
					{ label: 'Apps', value: stats.deploymentCount, href: undefined }
				]
			: []
	);

	onMount(async () => {
		try {
			const response = await apiFetch('/apiv1/admin/stats');
			if (!response.ok) throw new Error("Couldn't load instance stats");
			stats = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't load instance stats";
		} finally {
			loading = false;
		}
	});
</script>

<SetupChecklist />

<Stack gap="sm">
	<SectionTitle title="What is running here" />
	<Swap key={loading ? 'loading' : error ? 'error' : 'stats'}>
		{#if loading}
			<Skeleton class="h-20 w-full" />
		{:else if error}
			<Alert tone="error" title="Couldn't load instance stats">{error}</Alert>
		{:else}
			<div class="metrics">
				{#each metrics as metric (metric.label)}
					<Card href={metric.href}>
						<Metric label={metric.label} value={metric.value.toLocaleString()} />
					</Card>
				{/each}
			</div>
		{/if}
	</Swap>
</Stack>

<style>
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-3);
	}
</style>
