<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { Cpu } from '@jis3r/icons';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { isSuperAdmin } from '$lib/stores';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';
	import { springHover } from '$lib/utils/motion.svelte';

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
		resourcePressure,
		isImageSourceDeployment,
		imageInput = $bindable<string>(),
		imageDirty,
		savingImage,
		onSaveResources,
		onSaveImage,
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
		resourcePressure: { cpuRatio: number | null; memRatio: number | null; cpuNear: boolean; memNear: boolean; any: boolean };
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
	} = $props();

	const currentLabel = $derived.by(() => {
		if (resourceCpuMilli === 0 && resourceMemoryBytes === 0) return 'Unlimited';
		if (resourceCpuMilli != null && resourceMemoryBytes != null)
			return `${fmtCpuPreset(resourceCpuMilli)} · ${fmtMemoryPreset(resourceMemoryBytes)}`;
		return 'Organization default';
	});


</script>

<div class="rt-stack">
	<!-- Container image (Docker deployments only) -->
	{#if isImageSourceDeployment}
		<section class="rt-card">
			<div class="rt-card-header">
				<h3 class="rt-card-title">Container Image</h3>
			</div>
			<div class="rt-card-body">
				<div class="rt-image-row">
					<div class="rt-image-input-wrap">
						<input
							type="text"
							class="rt-image-input"
							placeholder="ghcr.io/org/image:tag"
							bind:value={imageInput}
							disabled={savingImage}
						/>
						<span class="rt-image-current">
							Currently running <code>{deployment?.image || '—'}</code>
						</span>
					</div>
					<div class="rt-image-actions">
						<button
							class="rt-btn rt-btn--ghost"
							disabled={!imageDirty || savingImage}
							onclick={() => { imageInput = deployment?.image ?? ''; }}
						>Reset</button>
						<button
							class="rt-btn rt-btn--primary"
							disabled={!imageDirty || savingImage}
							onclick={onSaveImage}
							{@attach springHover({ lift: -1, stiffness: 400, damping: 24 })}
						>
							{#if savingImage}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							{savingImage ? 'Updating...' : 'Update'}
						</button>
					</div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Resources -->
	<section class="rt-card">
		<div class="rt-card-header">
			<h3 class="rt-card-title">CPU & Memory</h3>
			<div class="rt-current-badge">
				{currentLabel}
			</div>
		</div>

		<div class="rt-card-body">
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
				onchange={() => { resourcesDirty = true; }}
			/>
			<div class="rt-actions">
				<button
					class="rt-btn rt-btn--ghost"
					disabled={!resourcesDirty || savingResources}
					onclick={() => {
						resourceCpuMilli = deployment?.cpuRequestMilli ?? null;
						resourceMemoryBytes = deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
						resourcesDirty = false;
					}}
				>Reset</button>
				<button
					class="rt-btn rt-btn--primary"
					disabled={!resourcesDirty || savingResources}
					onclick={onSaveResources}
					{@attach springHover({ lift: -1, stiffness: 400, damping: 24 })}
				>
					{#if savingResources}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					{savingResources ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</section>
</div>

<style>
	.rt-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.rt-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03), 0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.rt-card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem;
	}
	.rt-card-title {
		font-size: 0.9375rem;
		font-weight: 650;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}
	.rt-card-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
	}
	.rt-current-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.625rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 600;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
		font-family: var(--font-mono);
	}
	.rt-card-body {
		padding: 0 1.5rem 1.5rem;
	}

	/* Image section */
	.rt-image-row {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.rt-image-input-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.rt-image-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		transition: border-color 150ms;
	}
	.rt-image-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
	}
	.rt-image-input:disabled {
		opacity: 0.6;
	}
	.rt-image-current {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	.rt-image-current code {
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		font-size: 0.6875rem;
	}
	.rt-image-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	/* Actions */
	.rt-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	/* Buttons */
	.rt-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
	}
	.rt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.rt-btn--primary {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.rt-btn--primary:hover:not(:disabled) { opacity: 0.9; }
	.rt-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.rt-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}
</style>
