<script lang="ts">
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { Button } from '$lib/components/ui';
	import { isSuperAdmin } from '$lib/stores';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';

	let {
		entity,
		resourceCpuMilli = $bindable<number | null>(),
		resourceMemoryBytes = $bindable<number | null>(),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit = null,
		effectiveMemLimit = null,
		resourcesDirty = $bindable<boolean>(),
		savingResources,
		currentCpuUsage = null,
		currentMemUsage = null,
		onSaveResources
	}: {
		entity: any;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit?: number | null;
		effectiveMemLimit?: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		currentCpuUsage?: number | null;
		currentMemUsage?: number | null;
		onSaveResources: () => void;
	} = $props();

	const currentLabel = $derived.by(() => {
		if (resourceCpuMilli === 0 && resourceMemoryBytes === 0) return 'Unlimited';
		if (resourceCpuMilli != null && resourceMemoryBytes != null)
			return `${fmtCpuPreset(resourceCpuMilli)} · ${fmtMemoryPreset(resourceMemoryBytes)}`;
		return 'Organization default';
	});
</script>

<section class="rl-card">
	<div class="rl-card-header">
		<h3 class="rl-card-title">CPU & Memory</h3>
		<div class="rl-current-badge">
			{currentLabel}
		</div>
	</div>

	<div class="rl-card-body">
		<ResourcePicker
			bind:cpuMilli={resourceCpuMilli}
			bind:memoryBytes={resourceMemoryBytes}
			defaultCpuMilli={orgDefaultCpuMilli}
			defaultMemoryBytes={orgDefaultMemoryBytes}
			showUnlimited={$isSuperAdmin}
			{currentCpuUsage}
			{currentMemUsage}
			maxCpuMilli={effectiveCpuLimit}
			maxMemoryBytes={effectiveMemLimit}
			onchange={() => {
				resourcesDirty = true;
			}}
		/>
		<div class="rl-actions">
			<Button
				variant="ghost"
				size="sm"
				disabled={!resourcesDirty || savingResources}
				onclick={() => {
					resourceCpuMilli = entity?.cpuRequestMilli ?? null;
					resourceMemoryBytes =
						entity?.memoryRequestBytes != null ? Number(entity.memoryRequestBytes) : null;
					resourcesDirty = false;
				}}>Reset</Button
			>
			<Button
				variant="primary"
				size="sm"
				disabled={!resourcesDirty}
				loading={savingResources}
				onclick={onSaveResources}
			>
				{savingResources ? 'Saving...' : 'Save'}
			</Button>
		</div>
	</div>
</section>

<style>
	.rl-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}
	.rl-card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem;
	}
	.rl-card-title {
		font-size: var(--text-body);
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}
	.rl-current-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-2xl);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
		font-family: var(--font-mono);
	}
	.rl-card-body {
		padding: 0 1.5rem 1.5rem;
	}
	.rl-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
</style>
