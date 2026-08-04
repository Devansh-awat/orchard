<script lang="ts">
	/**
	 * DeploysTab — merges History + Webhooks into one tab.
	 * History always shows; Webhooks section only for Docker image deployments.
	 */
	import { History } from '@jis3r/icons';
	import { Webhook } from 'lucide-svelte';
	import { springCollapse } from '$lib/utils/motion.svelte';
	import HistoryTab from './HistoryTab.svelte';
	import WebhooksTab from './WebhooksTab.svelte';
	import type { WebhookToken } from '$lib/types/deployment';

	let {
		// History
		deployment,
		rebuilding,
		rollingBackId = null,
		onRebuild,
		onOpenLogModal,
		onRollback,
		onViewBuildLogs,
		// Webhooks (Docker deployments only)
		isDockerImageDeployment = false,
		deploymentId,
		webhookTokens = [],
		webhookTokensLoading = false,
		creatingWebhookToken = false,
		deletingWebhookTokenId = null,
		newlyCreatedToken = $bindable(null),
		onCreateToken,
		onDeleteToken
	}: {
		deployment: any;
		rebuilding: boolean;
		rollingBackId?: string | null;
		onRebuild: () => void;
		onOpenLogModal: (id: string) => void;
		onRollback: (image: string) => void;
		onViewBuildLogs: () => void;
		isDockerImageDeployment?: boolean;
		deploymentId: string;
		webhookTokens?: WebhookToken[];
		webhookTokensLoading?: boolean;
		creatingWebhookToken?: boolean;
		deletingWebhookTokenId?: string | null;
		newlyCreatedToken?: string | null;
		onCreateToken?: (label: string) => void;
		onDeleteToken?: (id: string) => void;
	} = $props();

	let webhooksOpen = $state(true);
</script>

<div class="dt-stack">
	<!-- History always visible -->
	<HistoryTab
		{deployment}
		{rebuilding}
		{rollingBackId}
		{onRebuild}
		{onOpenLogModal}
		{onRollback}
		{onViewBuildLogs}
	/>

	<!-- Webhooks section for Docker image deployments -->
	{#if isDockerImageDeployment && onCreateToken && onDeleteToken}
		<div class="dt-section">
			<button class="dt-section-header" onclick={() => (webhooksOpen = !webhooksOpen)}>
				<div class="dt-section-icon">
					<Webhook class="h-4 w-4" />
				</div>
				<div class="dt-section-title-group">
					<h3 class="dt-section-title">Webhook triggers</h3>
				</div>
				<svg
					class="dt-chevron"
					class:dt-chevron--closed={!webhooksOpen}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</button>
			<div {@attach springCollapse(() => !webhooksOpen)}>
				<div class="dt-section-body">
					<WebhooksTab
						{deploymentId}
						{webhookTokens}
						{webhookTokensLoading}
						{creatingWebhookToken}
						{deletingWebhookTokenId}
						bind:newlyCreatedToken
						{onCreateToken}
						{onDeleteToken}
					/>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.dt-stack {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.dt-section {
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-lg);
		background-color: var(--surface-bg);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}
	.dt-section-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--center-channel-color);
		transition: background-color var(--dur-fast);
	}
	.dt-section-header:hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}
	.dt-section-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.dt-section-title-group {
		flex: 1;
		min-width: 0;
	}
	.dt-section-title {
		font-size: var(--text-callout);
		font-weight: 600;
		margin: 0;
		line-height: 1.3;
	}
	.dt-chevron {
		width: 1rem;
		height: 1rem;
		color: var(--surface-muted);
		flex-shrink: 0;
		transition: transform var(--dur-base) ease;
	}
	.dt-chevron--closed {
		transform: rotate(-90deg);
	}
	.dt-section-body {
		padding: 0 1.25rem 1.25rem;
	}
</style>
