<script lang="ts">
	/**
	 * SettingsTab — merges Advanced + Audit Log into one tab
	 * with collapsible sections for strategy, build options, auto-deploy,
	 * health checks, and audit log.
	 */
	import { SlidersHorizontal, ClipboardList } from '@jis3r/icons';
	import { springCollapse } from '$lib/utils/motion.svelte';
	import AdvancedTab from './AdvancedTab.svelte';
	import AuditLogList from '$lib/components/AuditLogList.svelte';
	import type { AutoDeployStatus, GitHubDeploymentRecord } from '$lib/types/deployment';

	let {
		deployment,
		// Strategy
		strategyValue = $bindable<'rollingUpdate' | 'recreate'>('rollingUpdate'),
		savingStrategy,
		hasPvcVolume,
		onSaveStrategy,
		// Build options
		buildFromRoot = $bindable(false),
		buildWithDepot = $bindable(false),
		savingAdvanced,
		onSaveAdvanced,
		// Auto-deploy
		autoDeployStatus,
		autoDeployLoading,
		autoDeployBranch = $bindable(''),
		enablingAutoDeploy,
		disablingAutoDeploy,
		githubDeployments,
		githubAppInstallUrl,
		loadingAppInstallUrl,
		onEnableAutoDeploy,
		onDisableAutoDeploy,
		onOpenGitHubAppInstall,
		// Health checks
		healthCheckEnabled = $bindable(false),
		healthCheckType = $bindable('http'),
		healthCheckPath = $bindable('/'),
		healthCheckPort = $bindable(80),
		healthCheckCommand = $bindable(''),
		livenessEnabled = $bindable(true),
		readinessEnabled = $bindable(true),
		startupEnabled = $bindable(false),
		healthCheckInterval = $bindable(30),
		healthCheckTimeout = $bindable(5),
		healthCheckRetries = $bindable(3),
		startupFailureThreshold = $bindable(30),
		savingHealthCheck,
		isEditingHealthCheck = $bindable(false),
		onSaveHealthCheck,
	}: {
		deployment: any;
		strategyValue: 'rollingUpdate' | 'recreate';
		savingStrategy: boolean;
		hasPvcVolume: boolean;
		onSaveStrategy: () => void;
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		savingAdvanced: boolean;
		onSaveAdvanced: () => void;
		autoDeployStatus: AutoDeployStatus | null;
		autoDeployLoading: boolean;
		autoDeployBranch: string;
		enablingAutoDeploy: boolean;
		disablingAutoDeploy: boolean;
		githubDeployments: GitHubDeploymentRecord[];
		githubAppInstallUrl: string | null;
		loadingAppInstallUrl: boolean;
		onEnableAutoDeploy: () => void;
		onDisableAutoDeploy: () => void;
		onOpenGitHubAppInstall: () => void;
		healthCheckEnabled: boolean;
		healthCheckType: string;
		healthCheckPath: string;
		healthCheckPort: number;
		healthCheckCommand: string;
		livenessEnabled: boolean;
		readinessEnabled: boolean;
		startupEnabled: boolean;
		healthCheckInterval: number;
		healthCheckTimeout: number;
		healthCheckRetries: number;
		startupFailureThreshold: number;
		savingHealthCheck: boolean;
		isEditingHealthCheck: boolean;
		onSaveHealthCheck: () => void;
	} = $props();

	let auditOpen = $state(false);
</script>

<div class="st-stack">
	<!-- Advanced settings (always open, it's the primary content) -->
	<AdvancedTab
		{deployment}
		bind:strategyValue
		{savingStrategy}
		{hasPvcVolume}
		{onSaveStrategy}
		bind:buildFromRoot
		bind:buildWithDepot
		{savingAdvanced}
		{onSaveAdvanced}
		{autoDeployStatus}
		{autoDeployLoading}
		bind:autoDeployBranch
		{enablingAutoDeploy}
		{disablingAutoDeploy}
		{githubDeployments}
		{githubAppInstallUrl}
		{loadingAppInstallUrl}
		{onEnableAutoDeploy}
		{onDisableAutoDeploy}
		{onOpenGitHubAppInstall}
		bind:healthCheckEnabled
		bind:healthCheckType
		bind:healthCheckPath
		bind:healthCheckPort
		bind:healthCheckCommand
		bind:livenessEnabled
		bind:readinessEnabled
		bind:startupEnabled
		bind:healthCheckInterval
		bind:healthCheckTimeout
		bind:healthCheckRetries
		bind:startupFailureThreshold
		{savingHealthCheck}
		bind:isEditingHealthCheck
		{onSaveHealthCheck}
	/>

	<!-- Audit log (collapsed by default — it's secondary) -->
	<div class="st-section">
		<button class="st-section-header" onclick={() => (auditOpen = !auditOpen)}>
			<div class="st-section-icon">
				<ClipboardList size={16} animate={!auditOpen} />
			</div>
			<div class="st-section-title-group">
				<h3 class="st-section-title">Audit Log</h3>
			</div>
			<svg class="st-chevron" class:st-chevron--closed={!auditOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>
		<div {@attach springCollapse(() => !auditOpen)}>
			<div class="st-section-body">
				{#if auditOpen && deployment?.id}
					<AuditLogList scope={{ deploymentId: deployment.id }} title="Recent activity" />
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.st-stack {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.st-section {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03);
		overflow: hidden;
	}
	.st-section-header {
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
		transition: background-color 120ms;
	}
	.st-section-header:hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}
	.st-section-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--center-channel-color) 7%, transparent);
		color: var(--center-channel-color);
	}
	.st-section-title-group {
		flex: 1;
		min-width: 0;
	}
	.st-section-title {
		font-size: 0.875rem;
		font-weight: 600;
		margin: 0;
		line-height: 1.3;
	}
	.st-section-desc {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin: 0.0625rem 0 0;
	}
	.st-chevron {
		width: 1rem;
		height: 1rem;
		color: var(--surface-muted);
		flex-shrink: 0;
		transition: transform 200ms ease;
	}
	.st-chevron--closed {
		transform: rotate(-90deg);
	}
	.st-section-body {
		padding: 0 1.25rem 1.25rem;
	}
</style>
