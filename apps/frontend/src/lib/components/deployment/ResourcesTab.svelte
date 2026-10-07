<script lang="ts">
	import { TriangleAlert } from 'lucide-svelte';
	import ResourceLimits from '$lib/components/ResourceLimits.svelte';
	import { Button, SectionCard, SegmentedControl } from '$lib/components/ui';
	import { isMutableTag } from './deployment-helpers';
	import RegistryAccess from './RegistryAccess.svelte';

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
		pullPolicy = null,
		effectivePullPolicy = 'IfNotPresent',
		savingPullPolicy = false,
		onSaveResources,
		onSaveImage,
		onSavePullPolicy
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
		pullPolicy?: 'Always' | 'IfNotPresent' | null;
		effectivePullPolicy?: 'Always' | 'IfNotPresent';
		savingPullPolicy?: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
		onSavePullPolicy?: (next: 'Always' | 'IfNotPresent' | null) => void;
	} = $props();

	const tagCanMove = $derived(isMutableTag(deployment?.image));
	const isAuto = $derived(pullPolicy == null);
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

			<div class="rt-pull">
				<div class="rt-pull-head">
					<span class="rt-pull-title">Pull policy</span>
					<SegmentedControl
						label="Image pull policy"
						value={pullPolicy ?? 'auto'}
						options={[
							{ value: 'auto', label: 'Automatic' },
							{ value: 'IfNotPresent', label: 'Use cached' },
							{ value: 'Always', label: 'Always re-pull' }
						]}
						onchange={(next: string) =>
							onSavePullPolicy?.(next === 'auto' ? null : (next as 'Always' | 'IfNotPresent'))}
					/>
				</div>
				{#if !isAuto && tagCanMove && pullPolicy === 'IfNotPresent'}
					<div class="rt-pull-note">
						<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
						<span>
							This tag can move, and you have pinned this to the cached image. Restarting will not
							pick up a new push to the same tag. Switch back to Automatic to undo this.
						</span>
					</div>
				{:else if isAuto}
					<p class="rt-pull-help">
						{effectivePullPolicy === 'Always'
							? 'This tag can move, so every pod start fetches it again and restarting picks up a new push.'
							: 'This tag is pinned, so pods reuse the image already on the node. Change the tag and this adjusts on its own.'}
					</p>
				{:else}
					<p class="rt-pull-help">
						{pullPolicy === 'Always'
							? 'Every pod start fetches the image again, so restarting picks up a new push to this tag.'
							: 'Pods reuse the image already on the node.'}
					</p>
				{/if}
			</div>

			<RegistryAccess
				projectId={deployment?.projectId ?? ''}
				image={imageInput || deployment?.image || ''}
			/>
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
	.rt-pull {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border-subtle);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rt-pull-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.rt-pull-title {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-fg);
	}
	.rt-pull-help {
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.rt-pull-note {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--status-warning-border, var(--border-edge));
		background-color: var(--status-warning-bg);
		color: var(--status-warning);
		padding: 0.5rem 0.625rem;
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
	}
	.rt-image-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
