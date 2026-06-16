<script lang="ts">
	/**
	 * ConfigureTab — merges Environment + Resources + Storage into one tab
	 * with collapsible sections. Each section delegates to the existing
	 * tab component, keeping all their logic intact.
	 */
	import { Settings, HardDriveDownload, Cpu } from '@jis3r/icons';
	import { springCollapse } from '$lib/utils/motion.svelte';
	import EnvironmentTab from './EnvironmentTab.svelte';
	import ResourcesTab from './ResourcesTab.svelte';
	import VolumesTab from './VolumesTab.svelte';
	import type { Volume } from '$lib/types/deployment';

	let {
		// Environment
		envVars = $bindable([]),
		savingEnv,
		onSaveEnv,
		// Resources
		deployment,
		resourceCpuMilli = $bindable<number | null>(null),
		resourceMemoryBytes = $bindable<number | null>(null),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		resourcesDirty = $bindable(false),
		savingResources,
		resourcePressure,
		isImageSourceDeployment,
		imageInput = $bindable(''),
		imageDirty,
		savingImage,
		onSaveResources,
		onSaveImage,
		// Volumes
		volumes = $bindable<Volume[]>([]),
		savingVolumes,
		hasPvcVolume,
		onSaveVolumes
	}: {
		envVars: Array<{ key: string; value: string }>;
		savingEnv: boolean;
		onSaveEnv: () => void;
		deployment: any;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		resourcePressure: {
			cpuPercent: number | null;
			memoryPercent: number | null;
			cpuWarning: boolean;
			memoryWarning: boolean;
		};
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
		volumes: Volume[];
		savingVolumes: boolean;
		hasPvcVolume: boolean;
		onSaveVolumes: () => void;
	} = $props();

	let envOpen = $state(true);
	let resourcesOpen = $state(true);
	let storageOpen = $state(true);
</script>

<div class="ct-stack">
	<!-- Environment section -->
	<div class="ct-section">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<button class="ct-section-header" onclick={() => (envOpen = !envOpen)}>
			<div class="ct-section-icon ct-section-icon--blue">
				<Settings size={16} animate={!envOpen} />
			</div>
			<div class="ct-section-title-group">
				<h3 class="ct-section-title">Environment Variables</h3>
				<p class="ct-section-desc">Config & secrets for your app</p>
			</div>
			<svg
				class="ct-chevron"
				class:ct-chevron--closed={!envOpen}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>
		<div {@attach springCollapse(() => !envOpen)}>
			<div class="ct-section-body">
				<EnvironmentTab bind:envVars {savingEnv} onSave={onSaveEnv} />
			</div>
		</div>
	</div>

	<!-- Resources section -->
	<div class="ct-section">
		<button class="ct-section-header" onclick={() => (resourcesOpen = !resourcesOpen)}>
			<div class="ct-section-icon ct-section-icon--amber">
				<Cpu size={16} animate={!resourcesOpen} />
			</div>
			<div class="ct-section-title-group">
				<h3 class="ct-section-title">Resources</h3>
				<p class="ct-section-desc">CPU & memory allocation</p>
			</div>
			<svg
				class="ct-chevron"
				class:ct-chevron--closed={!resourcesOpen}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>
		<div {@attach springCollapse(() => !resourcesOpen)}>
			<div class="ct-section-body">
				<ResourcesTab
					{deployment}
					bind:resourceCpuMilli
					bind:resourceMemoryBytes
					{orgDefaultCpuMilli}
					{orgDefaultMemoryBytes}
					bind:resourcesDirty
					{savingResources}
					{resourcePressure}
					{isImageSourceDeployment}
					bind:imageInput
					{imageDirty}
					{savingImage}
					{onSaveResources}
					{onSaveImage}
				/>
			</div>
		</div>
	</div>

	<!-- Storage section -->
	<div class="ct-section">
		<button class="ct-section-header" onclick={() => (storageOpen = !storageOpen)}>
			<div class="ct-section-icon ct-section-icon--green">
				<HardDriveDownload size={16} animate={!storageOpen} />
			</div>
			<div class="ct-section-title-group">
				<h3 class="ct-section-title">Storage</h3>
				<p class="ct-section-desc">Persistent volumes & mounts</p>
			</div>
			<svg
				class="ct-chevron"
				class:ct-chevron--closed={!storageOpen}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>
		<div {@attach springCollapse(() => !storageOpen)}>
			<div class="ct-section-body">
				<VolumesTab bind:volumes {savingVolumes} {hasPvcVolume} onSave={onSaveVolumes} />
			</div>
		</div>
	</div>
</div>

<style>
	.ct-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.ct-section {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.ct-section-header {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 1.125rem 1.5rem;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--center-channel-color);
		transition: background-color 120ms;
	}
	.ct-section-header:hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}
	.ct-section-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
	}
	.ct-section-icon--blue {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.ct-section-icon--amber {
		background-color: color-mix(in srgb, var(--away-indicator) 12%, transparent);
		color: var(--away-indicator);
	}
	.ct-section-icon--green {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.ct-section-title-group {
		flex: 1;
		min-width: 0;
	}
	.ct-section-title {
		font-size: 0.9375rem;
		font-weight: 650;
		margin: 0;
		line-height: 1.3;
	}
	.ct-section-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
	}
	.ct-chevron {
		width: 1.125rem;
		height: 1.125rem;
		color: var(--surface-muted);
		flex-shrink: 0;
		transition: transform 200ms ease;
	}
	.ct-chevron--closed {
		transform: rotate(-90deg);
	}
	.ct-section-body {
		padding: 0.25rem 1.5rem 1.5rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
</style>
