<script lang="ts">
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { Button, FormActions, SectionCard } from '$lib/components/ui';
	import { isSuperAdmin } from '$lib/stores';
	import NodePoolPicker from './NodePoolPicker.svelte';

	let {
		deployment,
		resourceCpuMilli = $bindable<number | null>(),
		resourceMemoryBytes = $bindable<number | null>(),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit = null,
		effectiveMemLimit = null,
		resourcesDirty = $bindable<boolean>(),
		savingResources,
		onSaveResources,
		onDeploymentUpdated
	}: {
		deployment: any;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit?: number | null;
		effectiveMemLimit?: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		onSaveResources: () => void;
		onDeploymentUpdated?: (updated: any) => void;
	} = $props();

	function discard() {
		resourceCpuMilli = deployment?.cpuRequestMilli ?? null;
		resourceMemoryBytes =
			deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
		resourcesDirty = false;
	}
</script>

<SectionCard title="CPU and memory">
	<div class="rt-body">
		<ResourcePicker
			bind:cpuMilli={resourceCpuMilli}
			bind:memoryBytes={resourceMemoryBytes}
			defaultCpuMilli={orgDefaultCpuMilli}
			defaultMemoryBytes={orgDefaultMemoryBytes}
			showUnlimited={$isSuperAdmin}
			currentCpuUsage={deployment?.totalCpuUsage}
			currentMemUsage={deployment?.totalMemoryUsage}
			maxCpuMilli={effectiveCpuLimit}
			maxMemoryBytes={effectiveMemLimit}
			onchange={() => (resourcesDirty = true)}
		/>
		<FormActions hint="Saving restarts your app.">
			<Button variant="ghost" disabled={!resourcesDirty || savingResources} onclick={discard}
				>Discard</Button
			>
			<Button
				variant="primary"
				disabled={!resourcesDirty}
				loading={savingResources}
				onclick={onSaveResources}>Save</Button
			>
		</FormActions>
	</div>
</SectionCard>

{#if deployment?.id}
	<NodePoolPicker
		deploymentId={deployment.id}
		nodePoolId={deployment.nodePoolId}
		onSaved={onDeploymentUpdated}
	/>
{/if}

<style>
	.rt-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
</style>
