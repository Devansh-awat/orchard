<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { apiFetch, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { ArrowLeft, Loader2, RefreshCw, Container } from 'lucide-svelte';
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

	function getStatusColor(phase: string) {
		switch (phase?.toLowerCase()) {
			case 'running':
				return 'badge-success';
			case 'pending':
				return 'badge-warning';
			case 'failed':
			case 'error':
				return 'badge-error';
			default:
				return 'badge-neutral';
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
			podSseUnsub = subscribeOrgEvents(
				orgIdForSse,
				(ev) => {
					if (ev.type === 'pod.changed' || ev.type === 'deployment.changed') {
						fetchPodDetails({ silent: true });
					}
				},
				// SSE handler refetches directly; don't also re-run the loader.
				{ invalidateDependencies: [] },
			);
		}
	});

	onDestroy(() => podSseUnsub?.());
</script>

<div class="p-6">
	<a
		href="/{orgSlug}"
		class="mb-6 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
	>
		<ArrowLeft class="h-4 w-4" />
		Back
	</a>

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-center">
				<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
				<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading pod details...</p>
			</div>
		</div>
	{:else if pod}
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between">
			<div>
				<h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">{pod.metadata.name}</h1>
				<span class="badge {getStatusColor(pod.status.phase)} mt-2">{pod.status.phase}</span>
			</div>
			<button onclick={fetchPodDetails} disabled={loading} class="btn btn-secondary">
				<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
				Refresh
			</button>
		</div>

		<!-- Pod Info -->
		<div class="card mb-6">
			<div class="card-body">
				<h2 class="text-lg font-semibold mb-4">Pod Information</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<p class="text-sm font-medium text-gray-500 dark:text-gray-400">Namespace</p>
						<p class="mt-1">{pod.metadata.namespace}</p>
					</div>
					<div>
						<p class="text-sm font-medium text-gray-500 dark:text-gray-400">Status</p>
						<span class="badge {getStatusColor(pod.status.phase)} mt-1">{pod.status.phase}</span>
					</div>
					<div>
						<p class="text-sm font-medium text-gray-500 dark:text-gray-400">Pod IP</p>
						<p class="mt-1 font-mono text-sm">{pod.status.podIP || 'N/A'}</p>
					</div>
					<div>
						<p class="text-sm font-medium text-gray-500 dark:text-gray-400">Host IP</p>
						<p class="mt-1 font-mono text-sm">{pod.status.hostIP || 'N/A'}</p>
					</div>
					<div class="col-span-2">
						<p class="text-sm font-medium text-gray-500 dark:text-gray-400">Start Time</p>
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
				<div class="divide-y divide-gray-200 dark:divide-gray-700">
					{#each pod.spec.containers as container}
						{@const status = pod.status.containerStatuses?.find((cs) => cs.name === container.name)}
						<div class="p-4">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-3">
									<Container class="h-5 w-5 text-gray-500" />
									<div>
										<p class="font-medium">{container.name}</p>
										<p class="text-sm text-gray-500 font-mono truncate max-w-md">{container.image}</p>
									</div>
								</div>
								{#if status}
									<span class="badge {status.ready ? 'badge-success' : 'badge-error'}">
										{status.ready ? 'Ready' : 'Not Ready'}
									</span>
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
						<select bind:value={selectedContainer} onchange={() => fetchLogs()} class="input w-auto">
							{#each pod.spec?.containers ?? [] as container}
								<option value={container.name}>{container.name}</option>
							{/each}
						</select>
						<input
							type="number"
							bind:value={tailLines}
							placeholder="Lines"
							class="input w-20"
						/>
						<button onclick={fetchLogs} disabled={logsLoading} class="btn btn-secondary btn-sm">
							{#if logsLoading}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<RefreshCw class="h-4 w-4" />
							{/if}
						</button>
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
					<p class="text-center py-8 text-gray-500">No logs available</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
