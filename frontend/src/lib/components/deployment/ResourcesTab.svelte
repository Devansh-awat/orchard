<script lang="ts">
	import { Loader2, TriangleAlert } from 'lucide-svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { isSuperAdmin } from '$lib/stores';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';
	import type { Deployment } from '$lib/types/deployment';

	let {
		deployment,
		resourceCpuMilli = $bindable<number | null>(),
		resourceMemoryBytes = $bindable<number | null>(),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		resourcesDirty = $bindable<boolean>(),
		savingResources,
		resourcePressure,
		isImageSourceDeployment,
		imageInput = $bindable<string>(),
		imageDirty,
		savingImage,
		onSaveResources,
		onSaveImage,
	}: {
		deployment: Deployment;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		resourcePressure: { cpuRatio: number | null; memRatio: number | null; cpuNear: boolean; memNear: boolean; any: boolean };
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
	} = $props();
</script>

{#if resourcePressure.any}
	<div class="strategy-note resource-warning mb-4">
		<TriangleAlert class="h-4 w-4 shrink-0" />
		<div>
			Usage is near this deployment's resource limits — consider assigning more
			{#if resourcePressure.cpuNear && resourcePressure.memNear}CPU and memory{:else if resourcePressure.cpuNear}CPU{:else}memory{/if},
			or pods might behave unexpectedly.
			<div class="resource-warning-ratios">
				{#if resourcePressure.cpuRatio != null}
					CPU {Math.round(resourcePressure.cpuRatio * 100)}%
				{/if}
				{#if resourcePressure.cpuRatio != null && resourcePressure.memRatio != null}
					·
				{/if}
				{#if resourcePressure.memRatio != null}
					Memory {Math.round(resourcePressure.memRatio * 100)}%
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if isImageSourceDeployment}
	<div class="card rounded-2xl p-5 mb-4">
		<div class="mb-3">
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Container image</p>
			<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
				Switch the Docker image this deployment runs. Pods will roll to pull the new image.
			</p>
		</div>
		<input
			type="text"
			class="image-input w-full rounded-md border px-3 py-2 text-sm font-mono"
			style="border-color: var(--surface-border); background-color: var(--control-bg); color: var(--center-channel-color);"
			placeholder="ghcr.io/org/image:tag"
			bind:value={imageInput}
			disabled={savingImage}
		/>
		<div class="mt-3 flex items-center justify-between gap-2">
			<p class="text-xs" style="color: var(--surface-muted);">
				Current: <span class="font-mono" style="color: var(--center-channel-color);">{deployment?.image || '—'}</span>
			</p>
			<div class="flex gap-2">
				<button
					class="btn btn-secondary"
					disabled={!imageDirty || savingImage}
					onclick={() => { imageInput = deployment?.image ?? ''; }}
				>Reset</button>
				<button
					class="btn btn-primary"
					disabled={!imageDirty || savingImage}
					onclick={onSaveImage}
				>
					{#if savingImage}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					<span>{savingImage ? 'Updating…' : 'Update image'}</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<div class="card rounded-2xl p-5">
	<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
		<div>
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Container resources</p>
			<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
				Pick a preset or set custom CPU and memory. Saving triggers a rolling restart of this deployment.
			</p>
		</div>
		<div class="text-xs" style="color: var(--surface-muted);">
			{#if resourceCpuMilli === 0 && resourceMemoryBytes === 0}
				Current: <strong style="color: #f59e0b;">Unlimited</strong>
			{:else if resourceCpuMilli != null && resourceMemoryBytes != null}
				Current: <strong style="color: var(--center-channel-color);">{fmtCpuPreset(resourceCpuMilli)} · {fmtMemoryPreset(resourceMemoryBytes)}</strong>
			{:else}
				Current: <strong style="color: var(--center-channel-color);">Organization default</strong>
			{/if}
		</div>
	</div>
	<ResourcePicker
		bind:cpuMilli={resourceCpuMilli}
		bind:memoryBytes={resourceMemoryBytes}
		defaultCpuMilli={orgDefaultCpuMilli}
		defaultMemoryBytes={orgDefaultMemoryBytes}
		showUnlimited={$isSuperAdmin}
		onchange={() => { resourcesDirty = true; }}
	/>
	<div class="mt-4 flex justify-end gap-2">
		<button
			class="btn btn-secondary"
			disabled={!resourcesDirty || savingResources}
			onclick={() => {
				resourceCpuMilli = deployment?.cpuRequestMilli ?? null;
				resourceMemoryBytes = deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
				resourcesDirty = false;
			}}
		>
			Reset
		</button>
		<button
			class="btn btn-primary"
			disabled={!resourcesDirty || savingResources}
			onclick={onSaveResources}
		>
			{savingResources ? 'Saving…' : 'Save resources'}
		</button>
	</div>
</div>
