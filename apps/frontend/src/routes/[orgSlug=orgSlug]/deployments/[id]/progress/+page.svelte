<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { ArrowLeft, Loader2, ExternalLink, X } from 'lucide-svelte';
	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';

	interface Deployment {
		id: string;
		name: string;
		status: string;
		buildStatus?: string;
		buildStep?: string | null;
		buildLogs?: string | null;
		buildError?: string | null;
		buildStepTimestamps?: Record<string, number> | null;
		githubRepo?: string | null;
		githubBranch?: string | null;
		buildType?: 'dockerfile' | 'railpack' | null;
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
		project?: {
			id: string;
			name: string;
			slug: string;
		};
	}

	let deployment = $state<Deployment | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let canceling = $state(false);
	// Keep track of logs separately to prevent them from disappearing during refresh
	let accumulatedLogs = $state<string | null>(null);

	const deploymentId = $derived($page.params.id);
	const orgSlug = $derived($page.params.orgSlug);

	let pollInterval: ReturnType<typeof setInterval>;

	async function fetchDeployment() {
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch app');
			}
			const data = await response.json();

			// Update accumulated logs - only update if new logs are longer or different
			if (data.buildLogs) {
				accumulatedLogs = data.buildLogs;
			}

			deployment = data;

			// If build succeeded, redirect to main deployment page
			if (data.buildStatus === 'succeeded' || data.status === 'running') {
				goto(`/${orgSlug}/deployments/${deploymentId}`, { replaceState: true });
			}
		} catch (e) {
			if (!deployment) {
				error = e instanceof Error ? e.message : 'Failed to fetch app';
			}
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchDeployment();
		// Poll every 2 seconds for faster updates
		pollInterval = setInterval(fetchDeployment, 2000);
	});

	onDestroy(() => {
		if (pollInterval) {
			clearInterval(pollInterval);
		}
	});

	const isGitHubDeploy = $derived(Boolean(deployment?.githubRepo));

	async function cancelBuild() {
		if (!deploymentId || canceling) return;

		canceling = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/cancel`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to cancel deployment');
			}

			toasts.add({
				title: 'Deployment cancelled',
				description: 'The deployment has been cancelled successfully',
				color: 'success'
			});

			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel deployment',
				color: 'error'
			});
		} finally {
			canceling = false;
		}
	}

	const canCancel = $derived(deployment?.status === 'building' || deployment?.status === 'pending');
</script>

<div class="progress-page min-h-screen">
	<div class="mx-auto max-w-2xl px-4 py-12">
		<button
			onclick={() => window.history.back()}
			class="back-link mb-8 inline-flex items-center gap-2 text-sm cursor-pointer"
		>
			<ArrowLeft class="h-4 w-4" />
			<span>Back to project</span>
		</button>

		{#if error}
			<div class="error-box rounded-lg p-4">
				<p class="text-sm">{error}</p>
			</div>
		{:else if loading}
			<div class="flex flex-col items-center justify-center py-16">
				<Loader2 class="h-12 w-12 animate-spin text-primary-600" />
				<p class="mt-4 muted-text">Loading app...</p>
			</div>
		{:else if deployment}
			<div class="card rounded-2xl p-8 shadow-lg">
				<div class="text-center mb-8">
					<h1 class="text-2xl font-bold">{deployment.name}</h1>
					{#if deployment.githubRepo}
						<div class="mt-2 flex items-center justify-center gap-2 text-sm muted-text">
							<span class="font-mono">{deployment.githubBranch}</span>
							{#if deployment.buildType}
								<span
									class="rounded-full px-2 py-0.5 text-xs font-medium {deployment.buildType ===
									'railpack'
										? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
										: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'}"
								>
									{deployment.buildType === 'railpack' ? 'Railpack' : 'Dockerfile'}
								</span>
							{/if}
							<a
								href={deployment.githubRepo}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700"
							>
								<ExternalLink class="h-3.5 w-3.5" />
							</a>
						</div>
					{/if}
				</div>

				<DeploymentProgress
					status={deployment.status}
					buildStatus={deployment.buildStatus}
					buildStep={deployment.buildStep}
					buildLogs={deployment.buildLogs ?? accumulatedLogs}
					buildError={deployment.buildError}
					{isGitHubDeploy}
					warnings={deployment.warnings}
					buildStepTimestamps={deployment.buildStepTimestamps}
				/>

				<div class="mt-8 flex justify-center gap-3">
					{#if canCancel}
						<button
							onclick={cancelBuild}
							disabled={canceling}
							class="btn btn-secondary flex items-center gap-2"
						>
							{#if canceling}
								<Loader2 class="h-4 w-4 animate-spin" />
								Cancelling...
							{:else}
								<X class="h-4 w-4" />
								Cancel deployment
							{/if}
						</button>
					{/if}
					{#if deployment.status === 'failed'}
						<button onclick={() => window.history.back()} class="btn btn-secondary">
							Back to project
						</button>
						<a href="/{orgSlug}/deployments/{deployment.id}" class="btn btn-primary">
							View app
						</a>
					{/if}
				</div>
			</div>

			<div class="mt-6 text-center text-sm muted-text">
				{#if deployment.status === 'building' || deployment.status === 'pending'}
					<p>You'll be redirected automatically when the app is ready.</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.progress-page {
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
	}

	.back-link {
		color: var(--surface-muted);
	}

	.back-link:hover {
		color: var(--center-channel-color);
	}

	.muted-text {
		color: var(--surface-muted);
	}

	.card {
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.error-box {
		background-color: rgba(214, 60, 86, 0.1);
		border: 1px solid var(--error-text-color);
		color: var(--error-text-color);
	}
</style>
