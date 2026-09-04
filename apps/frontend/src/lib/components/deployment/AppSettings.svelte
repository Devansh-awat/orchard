<script lang="ts">
	import { SettingsRail, SectionCard, Button } from '$lib/components/ui';
	import { ResourceNotifications } from '$lib/components/notifications';
	import { featureFlag } from '$lib/posthog';
	import AdvancedTab from './AdvancedTab.svelte';
	import BuildTab from './BuildTab.svelte';
	import ResourcesTab from './ResourcesTab.svelte';
	import VolumesTab from './VolumesTab.svelte';
	import AuditLogList from '$lib/components/AuditLogList.svelte';
	import type { AutoDeployStatus, GitHubDeploymentRecord } from '$lib/types/deployment';

	let {
		deployment,
		organizationId = null,
		activeSection,
		hrefFor,
		onSourceUpdated,
		onDeploymentUpdated,
		onRebuild,
		rebuilding,
		strategyValue = $bindable<'rollingUpdate' | 'recreate'>('rollingUpdate'),
		savingStrategy,
		pdbMinAvailable = $bindable(1),
		savingPdb,
		onSavePdb,
		hasPvcVolume,
		onSaveStrategy,
		buildFromRoot = $bindable(false),
		buildWithDepot = $bindable(false),
		persistentBuildCache = $bindable(false),
		buildOptionsDirty = $bindable(false),
		savingAdvanced,
		onSaveAdvanced,
		savingBuildConfig,
		onSaveBuildConfig,
		autoDeployStatus,
		autoDeployLoading,
		autoDeployBranch = $bindable(''),
		autoDeployPaths = $bindable(''),
		savingAutoDeployPaths,
		onSaveAutoDeployPaths,
		enablingAutoDeploy,
		disablingAutoDeploy,
		githubDeployments,
		githubAppInstallUrl,
		loadingAppInstallUrl,
		onEnableAutoDeploy,
		onDisableAutoDeploy,
		onOpenGitHubAppInstall,
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
		resourceCpuMilli = $bindable(0),
		resourceMemoryBytes = $bindable(0),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit,
		effectiveMemLimit,
		resourcesDirty = $bindable(false),
		savingResources,
		isImageSourceDeployment,
		imageInput = $bindable(''),
		imageDirty,
		savingImage,
		pullPolicy,
		savingPullPolicy,
		onSaveResources,
		onSaveImage,
		onSavePullPolicy,
		volumes = $bindable([]),
		isEditingVolumes = $bindable(false),
		savingVolumes,
		onSaveVolumes,
		deleting,
		onShowDeleteModal
	}: {
		deployment: any;
		organizationId?: string | null;
		activeSection: string;
		hrefFor: (id: string) => string;
		onSourceUpdated: (updated: any) => void;
		onDeploymentUpdated?: (updated: any) => void;
		onRebuild: () => void;
		rebuilding: boolean;
		strategyValue: 'rollingUpdate' | 'recreate';
		savingStrategy: boolean;
		pdbMinAvailable: number;
		savingPdb: boolean;
		onSavePdb: () => void;
		hasPvcVolume: boolean;
		onSaveStrategy: (next: 'rollingUpdate' | 'recreate') => void;
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		buildOptionsDirty?: boolean;
		savingAdvanced: boolean;
		onSaveAdvanced: () => void;
		savingBuildConfig: boolean;
		onSaveBuildConfig: (body: Record<string, string | null>) => void;
		autoDeployStatus: AutoDeployStatus | null;
		autoDeployLoading: boolean;
		autoDeployBranch: string;
		autoDeployPaths: string;
		savingAutoDeployPaths: boolean;
		onSaveAutoDeployPaths: () => void;
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
		resourceCpuMilli: number;
		resourceMemoryBytes: number;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit: number | null;
		effectiveMemLimit: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		pullPolicy?: 'Always' | 'IfNotPresent';
		savingPullPolicy?: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
		onSavePullPolicy?: (next: 'Always' | 'IfNotPresent') => void;
		volumes: any[];
		isEditingVolumes: boolean;
		savingVolumes: boolean;
		onSaveVolumes: () => void;
		deleting: boolean;
		onShowDeleteModal: () => void;
	} = $props();

	const notificationsEnabled = featureFlag('notifications');

	const RAIL = $derived([
		{
			label: 'App',
			items: [
				{ id: 'source', label: 'Source & build', href: hrefFor('source') },
				{ id: 'resources', label: 'Resources', href: hrefFor('resources') },
				{ id: 'storage', label: 'Storage', href: hrefFor('storage') }
			]
		},
		{
			label: 'Reliability',
			items: [
				{ id: 'health', label: 'Health checks', href: hrefFor('health') },
				{ id: 'behavior', label: 'Deploy behavior', href: hrefFor('behavior') },
				...($notificationsEnabled
					? [{ id: 'notifications', label: 'Notifications', href: hrefFor('notifications') }]
					: [])
			]
		},
		{
			label: 'Admin',
			items: [
				{ id: 'audit', label: 'Audit log', href: hrefFor('audit') },
				{ id: 'danger', label: 'Danger zone', href: hrefFor('danger') }
			]
		}
	]);
</script>

<div class="as-grid">
	<SettingsRail groups={RAIL} activeId={activeSection} label="App settings sections" />
	<div class="as-stack">
		{#if activeSection === 'source'}
			<AdvancedTab
				{deployment}
				{onSourceUpdated}
				{onDeploymentUpdated}
				{onRebuild}
				{rebuilding}
				sections={['source', 'build']}
				bind:strategyValue
				{savingStrategy}
				bind:pdbMinAvailable
				{savingPdb}
				{onSavePdb}
				{hasPvcVolume}
				{onSaveStrategy}
				bind:buildFromRoot
				bind:buildWithDepot
				bind:persistentBuildCache
				bind:buildOptionsDirty
				{savingAdvanced}
				{onSaveAdvanced}
				{autoDeployStatus}
				{autoDeployLoading}
				bind:autoDeployBranch
				bind:autoDeployPaths
				{savingAutoDeployPaths}
				{onSaveAutoDeployPaths}
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
			{#if !isImageSourceDeployment}
				<BuildTab {deployment} saving={savingBuildConfig} onSave={onSaveBuildConfig} />
			{/if}
		{:else if activeSection === 'resources'}
			<ResourcesTab
				{deployment}
				bind:resourceCpuMilli
				bind:resourceMemoryBytes
				{orgDefaultCpuMilli}
				{orgDefaultMemoryBytes}
				{effectiveCpuLimit}
				{effectiveMemLimit}
				bind:resourcesDirty
				{savingResources}
				{isImageSourceDeployment}
				bind:imageInput
				{imageDirty}
				{savingImage}
				{onSaveResources}
				{onSaveImage}
				{pullPolicy}
				{savingPullPolicy}
				{onSavePullPolicy}
			/>
		{:else if activeSection === 'storage'}
			<VolumesTab
				bind:volumes
				bind:isEditing={isEditingVolumes}
				{savingVolumes}
				{hasPvcVolume}
				onSave={onSaveVolumes}
			/>
		{:else if activeSection === 'health'}
			<AdvancedTab
				{deployment}
				{onSourceUpdated}
				{onDeploymentUpdated}
				{onRebuild}
				{rebuilding}
				sections={['health']}
				bind:strategyValue
				{savingStrategy}
				bind:pdbMinAvailable
				{savingPdb}
				{onSavePdb}
				{hasPvcVolume}
				{onSaveStrategy}
				bind:buildFromRoot
				bind:buildWithDepot
				bind:persistentBuildCache
				bind:buildOptionsDirty
				{savingAdvanced}
				{onSaveAdvanced}
				{autoDeployStatus}
				{autoDeployLoading}
				bind:autoDeployBranch
				bind:autoDeployPaths
				{savingAutoDeployPaths}
				{onSaveAutoDeployPaths}
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
		{:else if activeSection === 'behavior'}
			<AdvancedTab
				{deployment}
				{onSourceUpdated}
				{onDeploymentUpdated}
				{onRebuild}
				{rebuilding}
				sections={['strategy', 'autodeploy']}
				bind:strategyValue
				{savingStrategy}
				bind:pdbMinAvailable
				{savingPdb}
				{onSavePdb}
				{hasPvcVolume}
				{onSaveStrategy}
				bind:buildFromRoot
				bind:buildWithDepot
				bind:persistentBuildCache
				bind:buildOptionsDirty
				{savingAdvanced}
				{onSaveAdvanced}
				{autoDeployStatus}
				{autoDeployLoading}
				bind:autoDeployBranch
				bind:autoDeployPaths
				{savingAutoDeployPaths}
				{onSaveAutoDeployPaths}
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
		{:else if activeSection === 'notifications'}
			{#if deployment?.id && organizationId}
				<SectionCard title="Notifications">
					<ResourceNotifications {organizationId} scopeType="deployment" scopeId={deployment.id} />
				</SectionCard>
			{/if}
		{:else if activeSection === 'audit'}
			{#if deployment?.id}
				<AuditLogList scope={{ deploymentId: deployment.id }} title="Recent activity" />
			{/if}
		{:else if activeSection === 'danger'}
			<SectionCard
				title="Delete this app"
				description="Removes the app, its pods, domains, and build history. Attached volumes and their data are deleted too. This cannot be undone."
			>
				{#snippet actions()}
					<Button variant="danger" size="sm" onclick={onShowDeleteModal} loading={deleting}>
						Delete app
					</Button>
				{/snippet}
			</SectionCard>
		{/if}
	</div>
</div>

<style>
	.as-grid {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: var(--space-6);
		align-items: start;
	}
	.as-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	@media (max-width: 900px) {
		.as-grid {
			grid-template-columns: 1fr;
			gap: var(--space-4);
		}
	}
</style>
