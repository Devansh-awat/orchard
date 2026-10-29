<script lang="ts">
	import HistoryTab from './HistoryTab.svelte';
	import WebhooksTab from './WebhooksTab.svelte';
	import type { WebhookToken } from '$lib/types/deployment';

	let {
		deployment,
		rollingBackId = null,
		onOpenLogModal,
		onRollback,
		onViewBuildLogs,
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
		rebuilding?: boolean;
		rollingBackId?: string | null;
		onRebuild?: () => void;
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
</script>

<div class="activity">
	<HistoryTab {deployment} {rollingBackId} {onOpenLogModal} {onRollback} {onViewBuildLogs} />

	{#if isDockerImageDeployment && onCreateToken && onDeleteToken}
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
	{/if}
</div>

<style>
	.activity {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
