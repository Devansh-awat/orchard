<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { toasts } from '$lib/stores';
	import ScanSummary from './security/ScanSummary.svelte';
	import PostureCard from './security/PostureCard.svelte';
	import VulnerabilityList from './security/VulnerabilityList.svelte';
	import { fetchSecurity, requestScan, type DeploymentSecurity } from './security/security-api';

	let {
		deploymentId,
		image = null,
		active = true
	}: {
		deploymentId: string;
		image?: string | null;
		active?: boolean;
	} = $props();

	const key = $derived(['deployment-security', deploymentId, image ?? null]);

	const query = createQuery(() => ({
		queryKey: key,
		queryFn: () => fetchSecurity(deploymentId),
		enabled: !!deploymentId && active,
		staleTime: 30_000,
		retry: 1,
		refetchInterval: (q) =>
			(q.state.data as DeploymentSecurity | undefined)?.scan.state === 'scanning' ? 3_000 : false,
		refetchIntervalInBackground: false
	}));

	let requesting = $state(false);

	const data = $derived((query.data as DeploymentSecurity | undefined) ?? null);
	const loadError = $derived(!data && query.error ? (query.error as Error).message : null);

	let lastResult = $state<DeploymentSecurity | null>(null);

	$effect(() => {
		const d = data;
		if (d?.scan.state === 'vulnerable' && d.vulnerabilities) lastResult = d;
	});

	const listed = $derived.by(() => {
		if (data?.scan.state === 'vulnerable') return data;
		if (data?.scan.state === 'scanning' && lastResult?.image.ref === data.image.ref)
			return lastResult;
		return null;
	});

	async function scan() {
		if (requesting) return;
		requesting = true;
		try {
			const next = await requestScan(deploymentId);
			queryClient.setQueryData(key, next);
		} catch (err) {
			toasts.add({ title: (err as Error).message || 'Could not start a scan', color: 'error' });
		} finally {
			requesting = false;
		}
	}

	function retry() {
		query.refetch();
	}
</script>

<div class="security">
	<div class="top">
		<ScanSummary {data} {loadError} {requesting} onScan={scan} onRetry={retry} />
		<PostureCard findings={data?.posture ?? null} failed={!!loadError} />
	</div>
	{#if listed}
		<VulnerabilityList
			vulnerabilities={listed.vulnerabilities}
			total={listed.scan.counts.total}
			truncated={listed.truncated}
			onRetry={retry}
		/>
	{/if}
</div>

<style>
	.security {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-width: 0;
	}
	.top {
		display: grid;
		grid-template-columns: minmax(0, 1.618fr) minmax(21rem, 1fr);
		gap: 1rem;
		align-items: stretch;
	}
	@media (max-width: 64rem) {
		.top {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
