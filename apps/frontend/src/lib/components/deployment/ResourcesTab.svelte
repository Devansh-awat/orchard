<script lang="ts">
	import ResourceLimits from '$lib/components/ResourceLimits.svelte';
	import { Button, SectionCard } from '$lib/components/ui';

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
		isImageSourceDeployment,
		imageInput = $bindable<string>(),
		imageDirty,
		savingImage,
		onSaveResources,
		onSaveImage
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
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
	} = $props();
</script>

<div class="rt-stack">
	{#if isImageSourceDeployment}
		<SectionCard title="Container image">
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
					<Button
						variant="ghost"
						size="sm"
						disabled={!imageDirty || savingImage}
						onclick={() => {
							imageInput = deployment?.image ?? '';
						}}>Reset</Button
					>
					<Button
						variant="primary"
						size="sm"
						disabled={!imageDirty}
						loading={savingImage}
						onclick={onSaveImage}
					>
						{savingImage ? 'Updating...' : 'Update'}
					</Button>
				</div>
			</div>
		</SectionCard>
	{/if}

	<ResourceLimits
		entity={deployment}
		bind:resourceCpuMilli
		bind:resourceMemoryBytes
		{orgDefaultCpuMilli}
		{orgDefaultMemoryBytes}
		{effectiveCpuLimit}
		{effectiveMemLimit}
		bind:resourcesDirty
		{savingResources}
		currentCpuUsage={deployment?.totalCpuUsage}
		currentMemUsage={deployment?.totalMemoryUsage}
		{onSaveResources}
	/>
</div>

<style>
	.rt-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.rt-image-row {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.rt-image-input-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rt-image-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: var(--font-mono);
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-sm);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		transition: border-color var(--dur-fast);
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
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
	}
	.rt-image-current code {
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}
	.rt-image-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
