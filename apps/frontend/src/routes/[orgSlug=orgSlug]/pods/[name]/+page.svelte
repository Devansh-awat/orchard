<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { apiFetch, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { ArrowLeft, Loader2, RefreshCw, Container } from 'lucide-svelte';
	import { Button, Badge, Select, Input } from '$lib/components/ui';
	import type { PageData } from './$types';

	interface ContainerStatus {
		name: string;
		ready: boolean;
	}

	interface PodContainer {
		name: string;
		image: string;
	}

	interface Pod {
		metadata: {
			name: string;
			namespace: string;
		};
		spec: {
			containers: PodContainer[];
		};
		status: {
			phase: string;
			podIP?: string;
			hostIP?: string;
			startTime?: string;
			containerStatuses?: ContainerStatus[];
		};
	}

	let pod = $state<Pod | null>(null);
	let loading = $state(true);
	let logsLoading = $state(false);
	let error = $state<string | null>(null);
	let logsError = $state<string | null>(null);

	let logs = $state<string>('');
	let selectedContainer = $state<string>('');
	let tailLines = $state(100);

	let { data } = $props<{ data: PageData }>();
	const podName = $derived(data.podName);
	const orgSlug = $derived($page.params.orgSlug);
	const namespace = $derived(data.namespace);
	let podSseUnsub: (() => void) | null = null;

	async function fetchPodDetails(opts?: { silent?: boolean }) {
		const silent = opts?.silent === true;
		if (!silent) {
			loading = true;
			error = null;
		}

		try {
			const response = await apiFetch(`/apiv1/pods/${podName}?namespace=${namespace}`);
			if (!response.ok) {
				throw new Error('Failed to fetch pod details');
			}
			pod = await response.json();

			// Set default container
			if (pod?.spec?.containers?.length && !selectedContainer) {
				selectedContainer = pod.spec.containers[0].name;
				await fetchLogs();
			}
		} catch (e) {
			if (!silent) {
				error = e instanceof Error ? e.message : 'Failed to fetch pod details';
			}
		} finally {
			if (!silent) loading = false;
		}
	}

	async function fetchLogs() {
		if (!selectedContainer) return;

		logsLoading = true;
		logsError = null;

		try {
			const response = await apiFetch(
				`/apiv1/pods/${podName}/logs?namespace=${namespace}&container=${selectedContainer}&tailLines=${tailLines}`
			);
			if (!response.ok) {
				throw new Error('Failed to fetch logs');
			}
			const data = await response.json();
			logs = data.logs || '';
		} catch (e) {
			logsError = e instanceof Error ? e.message : 'Failed to fetch logs';
		} finally {
			logsLoading = false;
		}
	}

	function getStatusTone(phase: string): 'success' | 'warning' | 'error' | 'neutral' {
		switch (phase?.toLowerCase()) {
			case 'running':
				return 'success';
			case 'pending':
				return 'warning';
			case 'failed':
			case 'error':
				return 'error';
			default:
				return 'neutral';
		}
	}

	$effect(() => {
		if (selectedContainer) {
			fetchLogs();
		}
	});

	onMount(() => {
		data.podPromise
			.then((seed: any) => {
				if (!pod) {
					pod = seed;
					if (pod?.spec?.containers?.length && !selectedContainer) {
						selectedContainer = pod.spec.containers[0].name;
					}
					loading = false;
				}
			})
			.catch(() => {});
		fetchPodDetails();
		const orgIdForSse = $selectedOrganization?.id;
		if (orgIdForSse) {
			podSseUnsub = subscribeOrgEvents(orgIdForSse, (ev) => {
				if (ev.type === 'pod.changed' || ev.type === 'deployment.changed') {
					fetchPodDetails({ silent: true });
				}
			});
		}
	});

	onDestroy(() => podSseUnsub?.());
</script>

<div class="p-6">
	<Button variant="ghost" size="sm" href="/{orgSlug}" class="mb-6">
		<ArrowLeft class="h-4 w-4" />
		Back
	</Button>

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-center">
				<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
				<p class="mt-2 text-sm" style="color: var(--surface-muted);">Loading pod details...</p>
			</div>
		</div>
	{:else if pod}
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between">
			<div>
				<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
					{pod.metadata.name}
				</h1>
				<span class="mt-2 inline-block">
					<Badge tone={getStatusTone(pod.status.phase)}>{pod.status.phase}</Badge>
				</span>
			</div>
			<Button variant="secondary" onclick={() => fetchPodDetails()} disabled={loading}>
				<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
				Refresh
			</Button>
		</div>

		<!-- Pod Info -->
		<div class="card mb-6">
			<div class="card-body">
				<h2 class="text-lg font-semibold mb-4">Pod information</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<p class="text-sm font-medium" style="color: var(--surface-muted);">Namespace</p>
						<p class="mt-1">{pod.metadata.namespace}</p>
					</div>
					<div>
						<p class="text-sm font-medium" style="color: var(--surface-muted);">Status</p>
						<span class="mt-1 inline-block">
							<Badge tone={getStatusTone(pod.status.phase)}>{pod.status.phase}</Badge>
						</span>
					</div>
					<div>
						<p class="text-sm font-medium" style="color: var(--surface-muted);">Pod IP</p>
						<p class="mt-1 font-mono text-sm">{pod.status.podIP || 'N/A'}</p>
					</div>
					<div>
						<p class="text-sm font-medium" style="color: var(--surface-muted);">Host IP</p>
						<p class="mt-1 font-mono text-sm">{pod.status.hostIP || 'N/A'}</p>
					</div>
					<div class="col-span-2">
						<p class="text-sm font-medium" style="color: var(--surface-muted);">Start time</p>
						<p class="mt-1">
							{pod.status.startTime ? new Date(pod.status.startTime).toLocaleString() : 'N/A'}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Containers -->
		{#if pod.spec?.containers?.length}
			<div class="card mb-6">
				<div class="card-header">
					<h2 class="font-semibold">Containers ({pod.spec.containers.length})</h2>
				</div>
				<div class="divide-y divide-[var(--surface-border)]">
					{#each pod.spec.containers as container (container.name)}
						{@const status = pod.status.containerStatuses?.find((cs) => cs.name === container.name)}
						<div class="p-4">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-3">
									<Container class="h-5 w-5" style="color: var(--surface-muted);" />
									<div>
										<p class="font-medium">{container.name}</p>
										<p
											class="text-sm font-mono truncate max-w-md"
											style="color: var(--surface-muted);"
										>
											{container.image}
										</p>
									</div>
								</div>
								{#if status}
									<Badge tone={status.ready ? 'success' : 'error'}>
										{status.ready ? 'Ready' : 'Not ready'}
									</Badge>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Logs -->
		<div class="card">
			<div class="card-header">
				<div class="flex items-center justify-between">
					<h2 class="font-semibold">Logs</h2>
					<div class="flex items-center gap-2">
						<Select bind:value={selectedContainer} onchange={() => fetchLogs()}>
							{#each pod.spec?.containers ?? [] as container (container.name)}
								<option value={container.name}>{container.name}</option>
							{/each}
						</Select>
						<Input type="number" bind:value={tailLines} placeholder="Lines" class="w-20" />
						<Button variant="secondary" size="sm" onclick={fetchLogs} loading={logsLoading}>
							{#if !logsLoading}
								<RefreshCw class="h-4 w-4" />
							{/if}
						</Button>
					</div>
				</div>
			</div>
			<div class="card-body">
				{#if logsError}
					<div class="alert alert-error mb-4">{logsError}</div>
				{/if}

				{#if logsLoading}
					<div class="flex justify-center py-8">
						<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
					</div>
				{:else if logs}
					<div class="log-viewer max-h-96 overflow-y-auto">
						<pre>{logs}</pre>
					</div>
				{:else}
					<p class="text-center py-8" style="color: var(--surface-muted);">No logs available</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
