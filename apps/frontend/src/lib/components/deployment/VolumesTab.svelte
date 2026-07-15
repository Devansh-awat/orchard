<script lang="ts">
	import { Plus, Loader2, TriangleAlert } from 'lucide-svelte';
	import { HardDriveDownload, Trash2 } from '@jis3r/icons';
	import { slide, fade } from '$lib/utils/transitions';
	import { SectionCard } from '$lib/components/ui';

	interface VolumeEntry {
		name: string;
		type: 'pvc' | 'hostPath' | 'emptyDir';
		mountPath: string;
		pvcName?: string;
		storageSize?: string;
		hostPath?: string;
		readOnly: boolean;
	}

	let {
		volumes = $bindable<VolumeEntry[]>(),
		isEditing = $bindable(false),
		savingVolumes,
		hasPvcVolume,
		onSave
	}: {
		volumes: VolumeEntry[];
		isEditing?: boolean;
		savingVolumes: boolean;
		hasPvcVolume: boolean;
		onSave: () => void;
	} = $props();

	function addVolume() {
		isEditing = true;
		volumes = [
			...volumes,
			{ name: '', type: 'pvc', mountPath: '', pvcName: '', storageSize: '1Gi', readOnly: false }
		];
	}

	function removeVolume(index: number) {
		isEditing = true;
		volumes = volumes.filter((_, i) => i !== index);
	}

	function handleSave() {
		isEditing = false;
		onSave();
	}
</script>

<SectionCard title="Persistent storage">
	{#snippet actions()}
		<button onclick={addVolume} class="btn btn-secondary btn-sm">
			<Plus class="h-4 w-4" />
			<span>Add storage</span>
		</button>
	{/snippet}
	{#if hasPvcVolume}
		<div class="strategy-note mb-4">
			<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
			<span
				>Rolling deployments are disabled because this app uses a PVC volume. Updates run with the <strong
					>Recreate</strong
				> strategy, so pods are torn down before new ones start.</span
			>
		</div>
	{/if}
	<div class="space-y-3" onfocusin={() => (isEditing = true)}>
		{#each volumes as volume, index (index)}
			<div class="vol-card" transition:slide={{ duration: 200 }}>
				<div class="vol-card-header">
					<div class="vol-card-number">{index + 1}</div>
					<div class="vol-card-fields">
						<div class="vol-field">
							<input
								type="text"
								bind:value={volume.pvcName}
								placeholder="Storage name"
								class="vol-input"
							/>
						</div>
						<span class="vol-arrow">→</span>
						<div class="vol-field">
							<input
								type="text"
								bind:value={volume.mountPath}
								placeholder="/data"
								class="vol-input vol-input-mono"
							/>
						</div>
						<div class="vol-field vol-field--size">
							<input
								type="text"
								bind:value={volume.storageSize}
								placeholder="1Gi"
								class="vol-input"
							/>
						</div>
					</div>
					<div class="vol-card-actions">
						<label class="dm-toggle-row vol-toggle">
							<span class="vol-toggle-label">Read-only</span>
							<input type="checkbox" class="dm-toggle-input" bind:checked={volume.readOnly} />
							<span class="dm-toggle-track"><span class="dm-toggle-thumb"></span></span>
						</label>
						<button onclick={() => removeVolume(index)} class="btn btn-ghost btn-sm vol-remove"
							><Trash2 size={14} class="h-3.5 w-3.5" /></button
						>
					</div>
				</div>
			</div>
		{:else}
			<div class="text-center py-8" transition:fade={{ duration: 150 }}>
				<span style="color: var(--surface-muted);"
					><HardDriveDownload size={32} class="h-8 w-8 mx-auto mb-2" /></span
				>
				<p class="text-sm font-medium" style="color: var(--center-channel-color);">
					No storage attached
				</p>
				<p class="text-xs mt-1" style="color: var(--surface-muted);">
					Add persistent storage to keep files across restarts.
				</p>
			</div>
		{/each}
	</div>
	<div class="mt-4 flex items-center justify-between">
		<p class="text-xs" style="color: var(--surface-muted);">
			Saving will restart your app with the new storage config.
		</p>
		<button onclick={handleSave} disabled={savingVolumes || !isEditing} class="btn btn-primary">
			{#if savingVolumes}<Loader2 class="h-4 w-4 animate-spin" />{/if}
			<span>Save</span>
		</button>
	</div>
</SectionCard>
